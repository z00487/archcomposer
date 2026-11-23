/**
 * L3 领域层 · 建筑讲解知识表与规则化生成器
 *
 * 依据：开题报告 §3.2「系统根据**建筑知识库**和三维模型，自动完成主要知识点组织、
 * 讲解顺序规划、目标构件匹配以及初始视点和视觉效果生成」。
 *
 * **这就是那个「建筑知识库」的第一版。** 它不是向量库、不是 RAG——它是一张
 * 结构化的小表：每个知识点写明「叫什么、用哪些词指它、由哪些构件承载、通常讲什么、
 * 建议什么意图、在整体讲解里排第几」。这张表的价值在于**它是可读、可审、可改的**，
 * 而检索出来的知识片段不可读也不可审。
 *
 * **为什么第一版可以只是一张表**：讲解内容的组织有很强的**套路性**——讲中国
 * 古建基本就是「整体 → 台基 → 柱 → 斗拱 → 梁 → 屋顶 → 脊」这一条线，术语也很收敛。
 * 把这套顺序固化成表，覆盖面就已经很广；真正的长尾（如「讲讲这座厅堂的抗震做法」）
 * 交给 LLM 那条路（见 `llm-generator.ts`）。
 *
 * **两条不能破的约束**（两者都是为了让生成结果可验证）：
 *  1. **只引用真实存在的构件**。生成器不得编造 ID——`matchKnowledge` 里所有构件
 *     都来自传入的 `components` 清单，命不中就是命不中；
 *  2. **输出确定**。同一个请求两次生成，结果逐字节相同（没有随机、没有时间依赖），
 *     因此可以写进 `npm run verify` 当作回归。
 */
import type {
  DraftStep,
  GenerationComponent,
  GenerationDraft,
  GenerationRequest,
  StoryboardGenerator,
} from './types.ts';
import type { IntentKind } from '../types/intent.ts';

// ── 知识表 ─────────────────────────────────────────────────────

export interface KnowledgeEntry {
  /** 知识点名（界面与旁白里用） */
  name: string;
  /** 指代词：作者这样写，就命中这个知识点 */
  words: string[];
  /** 承载这个知识点的构件类型 */
  kinds: string[];
  /** 讲解顺序的**层级权重**：小的先讲。这是「从整体到局部」的实现。 */
  order: number;
  /** 默认时长（毫秒） */
  durationMs: number;
  /** 建议的意图类型 */
  intentKind: IntentKind;
  /** 建议的运镜角度（可空）。「整体」这类知识点适合环绕一周。 */
  motionDegrees?: number;
  /** 这一讲讲什么——用作旁白的骨架（作者可改） */
  narration: string;
}

/**
 * 讲解顺序的来源（**这一处必须能被答辩追问**）：
 * 中国古建的讲解惯例是「**先观其形，再拆其构**」——先给整体印象（体量、开间、
 * 屋顶形式），再按**自下而上**的受力顺序拆解（台基承柱、柱承斗拱、斗拱承梁、
 * 梁架檩椽、屋面覆盖、脊收顶）。这个顺序本身就是一种「知识」，而不是随意排的。
 *
 * 因此 `order` 的值大致等于「从地面往上」的高度次序，只在「整体」与「总结」两端
 * 各加一个特殊位次。
 */
export const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  {
    name: '整体',
    words: ['整体', '全貌', '总体', '全景', '概况', '整体结构', '鸟瞰', '总体结构'],
    kinds: ['plinth'], // 没有专门的「整体」构件，用台基作锚点（它是建筑的水平基准）
    order: 0,
    durationMs: 6000,
    intentKind: 'SHOW_OVERVIEW',
    motionDegrees: 360,
    narration: '先看一眼整体：单檐悬山，三开间，坐落在一座石台基上。',
  },
  {
    name: '台基',
    words: ['台基', '基座', '础', '地基'],
    kinds: ['plinth'],
    order: 1,
    durationMs: 3500,
    intentKind: 'EMPHASIZE',
    narration: '整座建筑立在这方台基上，它把上部荷载分散到地面。',
  },
  {
    name: '柱础',
    words: ['柱础', '础石'],
    kinds: ['columnbase'],
    order: 2,
    durationMs: 3500,
    intentKind: 'EMPHASIZE',
    narration: '每根柱子脚下都垫着一块柱础，避免木柱直接接触潮气。',
  },
  {
    name: '檐柱',
    words: ['柱', '檐柱', '柱子', '柱梁', '立柱'],
    kinds: ['column'],
    order: 3,
    durationMs: 4000,
    intentKind: 'EMPHASIZE',
    narration: '柱子是竖向承重构件，把屋顶的重量一路传到台基。',
  },
  {
    name: '斗拱',
    words: ['斗拱', '斗栱', '铺作'],
    kinds: ['dougong'],
    order: 4,
    durationMs: 4500,
    intentKind: 'EMPHASIZE',
    narration: '斗拱坐在柱头上，把屋檐挑出屋身之外，同时是等级的象征。',
  },
  {
    name: '柱与斗拱的关系',
    words: ['关系', '承托', '搭接', '连接', '受力'],
    kinds: ['column', 'dougong'],
    order: 5,
    durationMs: 4500,
    intentKind: 'REVEAL_RELATION',
    narration: '这里能看清柱与斗拱的承托关系：斗拱正好压在柱头之上。',
  },
  {
    name: '梁',
    words: ['梁', '梁架', '横梁', '抬梁'],
    kinds: ['beam'],
    order: 6,
    durationMs: 4000,
    intentKind: 'EMPHASIZE',
    narration: '梁横架在柱与斗拱之上，是屋架的水平骨架。',
  },
  {
    name: '檩条',
    words: ['檩', '檩条', '桁', '脊檩', '檐檩'],
    kinds: ['purlin'],
    order: 7,
    durationMs: 4000,
    intentKind: 'REDUCE_OCCLUSION',
    narration: '檩条是纵向骨架构件，椽子就搭在它们上面。若正面看不全，系统会把挡住的构件调透明。',
  },
  {
    name: '椽',
    words: ['椽', '椽子', '檐椽'],
    kinds: ['rafter'],
    order: 8,
    durationMs: 3500,
    intentKind: 'REDUCE_OCCLUSION',
    narration: '一根根椽子密排，把屋面的荷载传给檩条。',
  },
  {
    name: '屋顶',
    words: ['屋顶', '屋面', '瓦', '房顶', '屋顶形式'],
    kinds: ['roof'],
    order: 9,
    durationMs: 4500,
    intentKind: 'EMPHASIZE',
    motionDegrees: 180,
    narration: '屋面是悬山顶的两坡，出檐深远，雨水可以甩得离墙脚很远。',
  },
  {
    name: '正脊',
    words: ['脊', '正脊', '屋脊'],
    kinds: ['ridge'],
    order: 10,
    durationMs: 3500,
    intentKind: 'EMPHASIZE',
    narration: '两坡屋面在最高处交汇成正脊，压住整个屋架。',
  },
  {
    name: '山墙',
    words: ['山墙', '山面', '悬山'],
    kinds: ['gable'],
    order: 11,
    durationMs: 3500,
    intentKind: 'EMPHASIZE',
    narration: '两侧的山墙收住屋面，悬山顶的檩条从这里挑出体外。',
  },
];

/** 按名字取知识点（无则 null）。 */
export function findKnowledge(name: string): KnowledgeEntry | null {
  return KNOWLEDGE_BASE.find((e) => e.name === name) ?? null;
}

// ── 目标文本 → 知识点 ──────────────────────────────────────────

/**
 * 扫描作者的目标文本，按**命中顺序**取出知识点序列，并去重。
 *
 * ⚠️ 这里有一个容易忽略的坑：**「整体结构」同时含「整体」与「结构」**，
 * 而「结构」又可能命中「柱梁」那一类的词。因此不能简单地遍历词表取第一个命中，
 * 而要**先把命中位置算出来**（作者先说的先讲，这是尊重作者意图），再去重。
 */
export function scanKnowledge(goal: string): Array<{ entry: KnowledgeEntry; at: number; hit: string }> {
  const found: Array<{ entry: KnowledgeEntry; at: number; hit: string }> = [];
  for (const entry of KNOWLEDGE_BASE) {
    for (const word of entry.words) {
      const at = goal.indexOf(word);
      if (at >= 0) {
        found.push({ entry, at, hit: word });
        break; // 同一个知识点只记一次（取它第一个命中的词）
      }
    }
  }
  // 按在文本里出现的先后排；同一位置时按知识表顺序，保证确定
  found.sort((a, b) => (a.at !== b.at ? a.at - b.at : a.entry.order - b.entry.order));
  return found;
}

/**
 * 解析目标文本 → 要讲的知识点列表。
 *
 * **空输入时给一套默认讲解**（整体 → 柱 → 斗拱 → 屋顶），这样「不写目标直接点生成」
 * 也能得到一个像样的初稿，而不是报错。
 */
export function planKnowledge(goal: string): KnowledgeEntry[] {
  const hits = scanKnowledge(goal);
  if (hits.length === 0) {
    // 默认讲解：覆盖「整体 + 竖向承重 + 转角构造 + 屋面」四个层次，
    // 是这座厅堂最短的一条完整讲解线
    return ['整体', '檐柱', '斗拱', '屋顶']
      .map((name) => findKnowledge(name)!)
      .filter(Boolean);
  }
  const out: KnowledgeEntry[] = [];
  for (const h of hits) if (!out.includes(h.entry)) out.push(h.entry);
  return out;
}

// ── 知识点 → 草稿步骤 ─────────────────────────────────────────

/** 为一个知识点挑选承载它的构件（优先选「东侧」这类容易看到的部位）。 */
export function pickComponent(
  entry: KnowledgeEntry,
  components: GenerationComponent[],
): { primary: GenerationComponent; partner?: GenerationComponent } | null {
  const pool = components.filter((c) => entry.kinds.includes(c.kind));
  if (pool.length === 0) return null;

  // 排序规则（确定性）：东侧 → 前檐 → 中央 → 其余，然后按 id 字典序。
  // 「东侧」优先是因为东侧是传统上的正面起始方向（也正好是本模型的观察起点）。
  const rank = (c: GenerationComponent): number => {
    const part = c.part ?? '';
    if (part.includes('e')) return 0;
    if (part.includes('front')) return 1;
    if (part.includes('c')) return 2;
    return 3;
  };
  const sorted = [...pool].sort((a, b) => {
    const d = rank(a) - rank(b);
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const primary = sorted[0];

  // 关系型知识点（REVEAL_RELATION）需要第二个构件：从**另一种**类型里挑一个
  if (entry.intentKind === 'REVEAL_RELATION') {
    const otherKinds = entry.kinds.filter((k) => k !== primary.kind);
    const partner = sorted.find((c) => c.kind !== primary.kind)
      ?? components.filter((c) => otherKinds.includes(c.kind))
        .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    return partner ? { primary, partner } : { primary };
  }

  return { primary };
}

/**
 * 生成草稿。
 *
 * **顺序规则**：如果作者在目标里**明确点了顺序**（说了「从整体到局部」「先…再…」），
 * 就按他的顺序；否则按知识表的 `order`（自下而上）。这条判断很重要——作者的
 * 显式顺序永远优先于我们的默认套路。
 */
export function generateRuleDraft(request: GenerationRequest): GenerationDraft {
  const notes: string[] = [];
  const warnings: string[] = [];

  const entries = planKnowledge(request.goal);
  if (scanKnowledge(request.goal).length === 0) {
    notes.push('目标里没有命中任何知识点，已给出一套默认讲解（整体 → 柱 → 斗拱 → 屋顶）');
  } else {
    notes.push(`按目标文本命中的顺序组织：${entries.map((e) => e.name).join(' → ')}`);
  }

  // 作者显式要求「从整体到局部」时，把整体类知识点强行提到最前
  const wantsWholeToPart = /从整体到局部|先整体|整体到细部|由大到小/.test(request.goal);
  if (wantsWholeToPart) {
    const sorted = [...entries].sort((a, b) => a.order - b.order);
    entries.length = 0;
    entries.push(...sorted);
    notes.push('目标里要求「从整体到局部」，已改按知识点的层级顺序（自下而上）排列');
  }

  const steps: DraftStep[] = [];
  for (const entry of entries) {
    const picked = pickComponent(entry, request.components);
    if (!picked) {
      // ★ 不静默跳过（与 FR-19 同一个立场）：如实告知，并把这一步列进 warnings
      warnings.push(
        `知识点「${entry.name}」在模型里找不到对应的 ${entry.kinds.join('/')} 构件，已跳过`,
      );
      continue;
    }

    const step: DraftStep = {
      title: entry.name,
      narration: entry.narration,
      targetId: picked.primary.id,
      intentKind: entry.intentKind,
      durationMs: entry.durationMs,
      reason: `目标里提到了这个知识点，由构件「${picked.primary.label}」承载`,
    };
    if (picked.partner) {
      step.partnerId = picked.partner.id;
      step.reason = `揭示「${picked.primary.label}」与「${picked.partner.label}」的关系`;
    }
    if (entry.motionDegrees) step.motionDegrees = entry.motionDegrees;

    steps.push(step);
  }

  // 时长：按知识点的默认时长之和缩放，使总时长贴近作者要求（±10% 内不再调整）
  if (request.targetDurationMs && steps.length > 0) {
    const total = steps.reduce((s, x) => s + x.durationMs, 0);
    const ratio = request.targetDurationMs / total;
    if (ratio > 1.1 || ratio < 0.9) {
      for (const s of steps) s.durationMs = Math.max(1500, Math.round(s.durationMs * ratio));
      notes.push(
        `按要求的 ${(request.targetDurationMs / 1000).toFixed(0)} 秒调整了各步时长（原合计 ${(total / 1000).toFixed(0)} 秒）`,
      );
    }
  }

  if (request.audience) {
    notes.push(`面向「${request.audience}」——旁白可按此调整深浅（作者可改）`);
  }

  return {
    title: deriveTitle(request.goal),
    steps,
    generator: 'rule-kb-v1',
    notes,
    warnings,
  };
}

/** 从目标文本里取一个标题。取不到就用默认名。 */
export function deriveTitle(goal: string): string {
  const trimmed = goal.trim();
  if (!trimmed) return '自动生成的讲解';
  // 取第一个分句，最长 18 字
  const first = trimmed.split(/[，。；,.;!?！？]/)[0].trim();
  return first.length > 18 ? `${first.slice(0, 18)}…` : first || '自动生成的讲解';
}

/** 规则化生成器（离线、确定、无依赖）。 */
export class RuleStoryboardGenerator implements StoryboardGenerator {
  readonly name = 'rule-kb-v1';
  readonly requiresNetwork = false;

  async generate(request: GenerationRequest): Promise<GenerationDraft> {
    return generateRuleDraft(request);
  }
}

/** 从场景摘要构造生成请求里的构件清单（L4 调用）。 */
export function toGenerationComponents(
  components: ReadonlyArray<{ id: string; semantics: { kind: string; part: string; label: string }; visible: boolean }>,
): GenerationComponent[] {
  return components
    .filter((c) => c.visible)
    .map((c) => ({
      id: c.id,
      kind: c.semantics.kind,
      part: c.semantics.part ?? '',
      label: c.semantics.label || c.id,
    }));
}
