/**
 * L4 应用层 · 生成服务（把「用哪条通道生成」这个决策收在一处）
 *
 * **为什么这个决策不该散在界面里**：界面上的「用大模型」只是一个勾选项，
 * 而「勾了但没配 key 怎么办」「勾了但网络断了怎么办」「勾了但模型全在编造构件
 * 怎么办」这三件事的答案必须一致且可解释。把它们收在一个函数里，界面就只需
 * 转述结果，不需要理解任何降级逻辑。
 *
 * **降级的三条规则**（与 `LlmStoryboardGenerator` 内部的两条合起来构成完整策略）：
 *
 *  1. **没勾** → 直接走规则生成。这是默认路径，也是离线演示与回归链走的路径；
 *  2. **勾了但没配 key** → 仍然尝试一次（代理层可能配了服务端 key，界面不知道），
 *     失败后按第 3 条处理；
 *  3. **勾了但调用失败/返回不可用** → 回退到规则生成，并**把原因写在 notes 里**。
 *     作者看到的是一份可用的草稿加一句「大模型不可用，已改用离线生成」，
 *     而不是一个红色错误框加一片空白。
 *
 * **唯一的例外是不回退的情形**：模型返回了合法 JSON 但**每一步都引用了不存在的
 * 构件**。此时回退会掩盖「模型在编造」这个事实，而作者会以为大模型真的好用。
 * 这条判断在 `LlmStoryboardGenerator` 里做（它返回空 steps + warnings），
 * 本函数尊重它：**有 warnings 且零有效步骤时不回退**。
 */
import { RuleStoryboardGenerator, toGenerationComponents } from '../../domain/generator/knowledge.ts';
import { LlmStoryboardGenerator } from '../../domain/generator/llm-generator.ts';
import type { GenerationDraft, GenerationRequest } from '../../domain/generator/types.ts';
import type { SceneSummary } from '../../domain/types/solver.ts';
import { createLlmComplete, type LlmSettings } from '../llm/client.ts';

export interface GenerateInput {
  goal: string;
  audience: string;
  /** 目标时长（分钟）；null 表示让生成器自己估 */
  minutes: number | null;
  useLlm: boolean;
}

export interface GenerateDeps {
  /** 取当前场景（没就绪时为 null，此时拒绝生成） */
  scene(): SceneSummary | null;
  /** 取当前设置（每次现读，改了设置立刻生效） */
  settings(): LlmSettings;
  /** 刻意留出的注入点：单测可以塞一个假的 complete，不打网络 */
  complete?: import('../../domain/generator/llm-generator.ts').Complete;
}

export interface GenerateOutcome {
  draft: GenerationDraft;
  /** 界面上显示的来源标签，如「离线知识表」「大模型 · deepseek-chat」 */
  source: string;
  /** 是否用到了大模型 */
  usedLlm: boolean;
}

/** 从请求与设置里拼出生成请求。**构件清单来自当前模型，生成器不得引用清单外的 ID。** */
export function buildGenerationRequest(scene: SceneSummary, input: GenerateInput): GenerationRequest {
  return {
    goal: input.goal.trim(),
    audience: input.audience.trim(),
    targetDurationMs: input.minutes ? Math.round(input.minutes * 60000) : null,
    components: toGenerationComponents(scene.components.map((c) => ({
      id: c.id,
      semantics: c.semantics,
      visible: true,
    }))),
    modelPrefix: scene.modelPrefix,
  };
}

/**
 * 执行一次生成。**永远返回一份可用的草稿**（除非场景没就绪，那时调用方会看到
 * 零步骤的草稿加一条 warning）。
 */
export async function generateDraft(input: GenerateInput, deps: GenerateDeps): Promise<GenerateOutcome> {
  const rule = new RuleStoryboardGenerator();

  const scene = deps.scene();
  if (!scene) {
    const empty = await rule.generate({
      goal: input.goal,
      audience: input.audience,
      targetDurationMs: null,
      components: [],
      modelPrefix: '',
    });
    return {
      draft: { ...empty, steps: [], warnings: ['场景尚未就绪：请等模型加载完成再生成'] },
      source: '未就绪',
      usedLlm: false,
    };
  }

  const request = buildGenerationRequest(scene, input);

  // ① 没勾大模型 → 规则通道。这条路径不碰网络，因此离线可用、结果确定。
  if (!input.useLlm) {
    return { draft: await rule.generate(request), source: '离线知识表', usedLlm: false };
  }

  // ② 勾了 → 走大模型通道（它内部在**网络失败**时会回退到同一份规则生成）
  const settings = deps.settings();
  const complete = deps.complete ?? createLlmComplete(() => settings);
  const llm = new LlmStoryboardGenerator(complete, settings.model);
  const draft = await llm.generate(request);

  // ③ 「模型全在编造」的例外：有告警而零有效步骤时**不回退**，
  //    把问题如实交给作者，免得他以为大模型这条路是好用的
  if (draft.steps.length === 0 && draft.warnings.length > 0) {
    return { draft, source: `大模型 · ${settings.model}（无可用结果）`, usedLlm: true };
  }

  return { draft, source: `大模型 · ${settings.model}`, usedLlm: true };
}
