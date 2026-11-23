/**
 * L3 领域层 · 基于大语言模型的生成器（装配层）
 *
 * 依据：开题报告 §3.2、答辩 PPT 第 5 页流程第一跳「LLM + RAG 组织知识与生成步骤」。
 *
 * **这一层的定位是「把 LLM 的输出归一成 `GenerationDraft`」**，它不自己发 HTTP——
 * 网络传输由一个注入进来的 `complete` 函数负责（实现在 L4 的 `app/llm/client.ts`，
 * 走本地代理转发）。这样切分有三个理由：
 *
 *  1. **可测**：给一个假的 `complete` 返回一段固定的 JSON，就能断言「构件 ID 校验」
 *     「字段缺失补齐」「模型胡说八道时的降级」这些真正容易出错的逻辑，
 *     不需要网络、不需要 key、不会因为模型换版本而测试红掉；
 *  2. **L3 不引运行时依赖**：`fetch` 虽然不在禁用清单里，但把传输层挡在外面
 *     能让领域层保持「纯数据进、纯数据出」，与约束 C-1 的精神一致；
 *  3. **换厂商只改一处**：DeepSeek / OpenAI 兼容网关 / 本地 Ollama 的差异全部
 *     收敛在 L4 那一个文件里。
 *
 * **一条不可让渡的纪律：LLM 不许编造构件。**
 * 模型返回的每一个 `targetId` 都会被拿去和真实构件清单比对，**对不上就丢弃这一步**
 * 并记进 `warnings`。原因是这条链路最危险的失败模式不是「讲得不好」，而是
 * 「指向一个不存在的构件」——那会让整个分镜在播放时崩掉，而且报错位置离原因很远，
 * 极难排查。宁可少讲一段，也不留下一个悬空引用。
 */
import type {
  DraftStep,
  GenerationDraft,
  GenerationRequest,
  StoryboardGenerator,
} from './types.ts';
import { deriveTitle, generateRuleDraft } from './knowledge.ts';
import { INTENT_LABELS } from '../types/intent.ts';
import type { IntentKind } from '../types/intent.ts';
import { KIND_LABELS } from '../types/vocabulary.ts';

/** 一次对话补全的请求（与厂商无关的最小形状）。 */
export interface CompletionRequest {
  /** 系统提示词 */
  system: string;
  /** 用户提示词 */
  user: string;
  /** 期望是 JSON */
  jsonMode: boolean;
}

export interface CompletionResult {
  ok: boolean;
  text: string;
  /** 失败原因（网络、HTTP 状态、超时），供 UI 如实显示 */
  error?: string;
  /** 实际使用的模型名，供论文记录 */
  model?: string;
}

export type Complete = (request: CompletionRequest) => Promise<CompletionResult>;

/** 把场景构件清单压成提示词里的一行行文本。 */
function componentCatalog(request: GenerationRequest): string {
  return request.components
    .map((c) => `- ${c.id} ｜ ${KIND_LABELS[c.kind as keyof typeof KIND_LABELS] ?? c.kind} ｜ ${c.label}`)
    .join('\n');
}

/** 系统提示词。**约束写得越死，后续校验越轻松。** */
export function buildSystemPrompt(): string {
  const intentList = Object.entries(INTENT_LABELS)
    .map(([k, v]) => `${k}（${v}）`)
    .join('、');
  return [
    '你是一位中国古建筑讲解的导演助手。你要根据讲解目标，把一段讲解拆成若干可拍摄的步骤。',
    '',
    '硬性要求：',
    '1. 只能使用用户给出的构件清单里的 ID，一个字都不能改、不能编造。若某个知识点找不到对应构件，直接不输出那一步。',
    '2. 讲解顺序遵守中国古建的通行讲法：先整体、再从下往上（台基→柱础→柱→斗拱→梁→檩椽→屋面→脊）。',
    '3. 每步的 narration 是一句可以直接念出来的中文旁白，20~60 字，不要出现「本步」「该构件」这类书面指代。',
    '4. intentKind 只能从这几个里选：' + intentList + '。',
    '5. 只输出 JSON，不要任何解释文字、不要 Markdown 代码块。',
    '',
    'JSON 结构：',
    '{"title":"分镜标题","steps":[{"title":"步骤名","narration":"旁白","targetId":"构件ID","partnerId":"可选，关系型目标的第二端","intentKind":"EMPHASIZE","durationMs":4000,"motionDegrees":0}]}',
  ].join('\n');
}

/** 用户提示词。 */
export function buildUserPrompt(request: GenerationRequest): string {
  return [
    `讲解目标：${request.goal || '（未填写，请自行组织一段完整的建筑讲解）'}`,
    `观众：${request.audience || '一般观众'}`,
    `目标总时长：${request.targetDurationMs ? `${Math.round(request.targetDurationMs / 1000)} 秒` : '（未指定，请按知识点数量估算）'}`,
    '',
    '可用构件清单（格式：ID ｜ 类型 ｜ 名称）：',
    componentCatalog(request),
  ].join('\n');
}

/** 从模型输出里抠出 JSON——**模型常把 JSON 包在 ```json 里，或前后加解释**。 */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();

  // ① 直接就是 JSON
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试 */
  }

  // ② 剥掉 Markdown 代码块
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* 继续尝试 */
    }
  }

  // ③ 取第一个 `{` 到最后一个 `}` 之间——模型有时会在前后写「好的，这是结果：」
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* 放弃 */
    }
  }

  return null;
}

const VALID_INTENTS = new Set(Object.keys(INTENT_LABELS));

/**
 * 把模型的 JSON 输出校验、归一成 `GenerationDraft`。
 *
 * **这是本文件最重要的函数**，因为模型的输出不可信。逐项检查：
 *  - `targetId` 必须存在于构件清单里 → 否则**丢弃整步**并记 warning；
 *  - `partnerId` 同样要存在 → 不存在就只丢这个字段（保留单目标），不必丢整步；
 *  - `intentKind` 必须在枚举里 → 否则退回 `EMPHASIZE` 并记 warning；
 *  - `durationMs` 必须是正数 → 否则取 4000；
 *  - `narration` / `title` 缺失 → 用目标构件的名字兜底，**不留空字符串**
 *    （空旁白在播放时是一段静默，比一句占位文案更糟）。
 */
export function normalizeDraft(
  raw: unknown,
  request: GenerationRequest,
  generatorName: string,
): GenerationDraft {
  const warnings: string[] = [];
  const notes: string[] = [];
  const byId = new Map(request.components.map((c) => [c.id, c]));

  if (typeof raw !== 'object' || raw === null) {
    return {
      title: deriveTitle(request.goal),
      steps: [],
      generator: generatorName,
      notes,
      warnings: ['模型返回的内容不是 JSON 对象，无法解析'],
    };
  }

  const obj = raw as Record<string, unknown>;
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
  if (rawSteps.length === 0) notes.push('模型没有给出任何步骤');

  const steps: DraftStep[] = [];
  for (const [index, item] of rawSteps.entries()) {
    if (typeof item !== 'object' || item === null) {
      warnings.push(`第 ${index + 1} 步不是一个对象，已丢弃`);
      continue;
    }
    const s = item as Record<string, unknown>;
    const targetId = typeof s.targetId === 'string' ? s.targetId.trim() : '';
    const component = byId.get(targetId);

    // ★ 最重要的一条校验：绝不接受模型编造的构件 ID
    if (!component) {
      warnings.push(
        `第 ${index + 1} 步引用了模型里不存在的构件「${targetId || '(空)'}」，已丢弃这一步`,
      );
      continue;
    }

    let intentKind = typeof s.intentKind === 'string' ? s.intentKind.toUpperCase() : '';
    if (!VALID_INTENTS.has(intentKind)) {
      if (intentKind) warnings.push(`第 ${index + 1} 步的意图「${intentKind}」不是合法类型，已退回「强调目标」`);
      intentKind = 'EMPHASIZE';
    }

    let partnerId: string | undefined;
    if (typeof s.partnerId === 'string' && s.partnerId.trim()) {
      if (byId.has(s.partnerId.trim())) partnerId = s.partnerId.trim();
      else warnings.push(`第 ${index + 1} 步的关系另一端「${s.partnerId}」不存在，已忽略该字段`);
    }

    const durationMs =
      typeof s.durationMs === 'number' && Number.isFinite(s.durationMs) && s.durationMs > 0
        ? Math.round(Math.min(Math.max(s.durationMs, 1500), 30000))
        : 4000;

    const motionDegrees =
      typeof s.motionDegrees === 'number' && Number.isFinite(s.motionDegrees) && s.motionDegrees !== 0
        ? s.motionDegrees
        : undefined;

    const title = typeof s.title === 'string' && s.title.trim() ? s.title.trim() : component.label;
    const narration =
      typeof s.narration === 'string' && s.narration.trim()
        ? s.narration.trim()
        : `这一步讲${component.label}。`;

    steps.push({
      title,
      narration,
      targetId: component.id,
      partnerId,
      intentKind: intentKind as IntentKind,
      durationMs,
      motionDegrees,
      reason: '由大语言模型根据讲解目标生成',
    });
  }

  return {
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : deriveTitle(request.goal),
    steps,
    generator: generatorName,
    notes,
    warnings,
  };
}

/**
 * LLM 生成器。
 *
 * **失败时的行为是本文件最需要想清楚的地方。** 三种失败各自不同：
 *  - **网络/鉴权失败**（`ok: false`）→ 回退到规则生成器，并在 `notes` 里写明
 *    「LLM 不可用（原因），已改用离线知识表生成」。作者拿到的仍是一份可用的初稿；
 *  - **返回了内容但不是合法 JSON** → 同样回退，并记下模型原文的前 200 字便于排查；
 *  - **解析成功但校验后一步不剩**（模型把 ID 全编错了）→ **不回退**，而是返回
 *    空草稿 + warning。因为这时作者需要知道的是「模型不听话」，而不是
 *    「悄悄换了一套结果」。
 */
export class LlmStoryboardGenerator implements StoryboardGenerator {
  readonly name: string;
  readonly requiresNetwork = true;
  /**
   * 注意：这里**不用构造函数参数属性**（`constructor(private x)`）——
   * 本工程的 `erasableSyntaxOnly` 禁止该语法（它是 TS 独有、无法擦除的运行时语义）。
   */
  private readonly complete: Complete;

  constructor(complete: Complete, modelLabel = 'llm') {
    this.complete = complete;
    this.name = `llm:${modelLabel}`;
  }

  async generate(request: GenerationRequest): Promise<GenerationDraft> {
    const result = await this.complete({
      system: buildSystemPrompt(),
      user: buildUserPrompt(request),
      jsonMode: true,
    });

    if (!result.ok) {
      const fallback = generateRuleDraft(request);
      fallback.notes.unshift(`大语言模型不可用（${result.error ?? '未知原因'}），已改用离线知识表生成`);
      return fallback;
    }

    const parsed = extractJson(result.text);
    if (parsed === null) {
      const fallback = generateRuleDraft(request);
      fallback.notes.unshift(
        `大语言模型没有返回可解析的 JSON，已改用离线知识表生成。模型原文开头：${result.text.slice(0, 200)}`,
      );
      return fallback;
    }

    const draft = normalizeDraft(parsed, request, this.name);
    if (draft.steps.length === 0) {
      draft.warnings.push(
        '模型返回的步骤没有一个引用了真实存在的构件——这一步**没有**回退到离线生成，以便你先看清模型的问题',
      );
    }
    return draft;
  }
}
