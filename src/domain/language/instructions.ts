/**
 * L3 领域层 · 自然语言编辑指令解析（开题报告 §3.3、答辩 PPT 第 3/5 页的「03 编辑」）
 *
 * **这一层解决的是「说一句就能改」里的「听懂」那半步。** 它把作者的中文指令
 * 解析成一组**结构化的分镜操作**（`EditCommand`），交给 L4 命令层执行。
 * 它自己不碰 Store、不碰 three、不碰 DOM——纯函数，因此可以在 Node 下逐条断言。
 *
 * **与 `intent/rules.ts` 是同一种思路的延续**（那里是从示范推断意图，这里是从
 * 语言推断操作），因此共享两条原则：
 *
 *  1. **规则化、不训练模型。** 理由同样是「规则就是可解释性」——解析结果里
 *     带着 `rationale`，界面能告诉作者「我把你说的『第二步』理解成了……，
 *     按这样处理可以吗」，而不是黑箱地改掉他的分镜。
 *  2. **拿不准就不猜。** 置信度低于阈值的指令**返回 `unrecognized`**，
 *     界面据此提示「没听懂，请换一种说法」——这比擅自改掉作者的内容好得多。
 *
 * **它与 LLM 通道的关系**：本模块是**离线可用**的那条路（不联网、不要 key、
 * 结果确定可复现）。若接了 LLM（见 `generator/`），LLM 的产出会被归一到同一种
 * `EditCommand` 结构上，于是命令层与界面**两条路共用一份代码**。
 */
import type { ComponentId } from '../types/component.ts';
import type { TargetRef } from '../types/solver.ts';
import type { IntentKind } from '../types/intent.ts';
import type { SceneSummary } from '../types/solver.ts';
import type { Storyboard, StoryboardStep } from '../types/storyboard.ts';
import { extractOrdinal, toChineseNumber } from './chinese.ts';
import { INTENT_LABELS } from '../types/intent.ts';

/** 低于此置信度的解析结果不执行，改为提示用户换一种说法。 */
export const MIN_COMMAND_CONFIDENCE = 0.4;

// ── 指令的形态 ─────────────────────────────────────────────────

export const EditCommandKind = {
  /** 调顺序：把某一步移到某个位置 */
  MoveStep: 'move-step',
  /** 删除某一步 */
  DeleteStep: 'delete-step',
  /** 复制某一步 */
  DuplicateStep: 'duplicate-step',
  /** 改意图类型 */
  SetIntent: 'set-intent',
  /** 改旁白 */
  SetNarration: 'set-narration',
  /** 改时长 */
  SetDuration: 'set-duration',
  /** 改运镜 */
  SetMotion: 'set-motion',
  /** 隐藏某类构件（减少遮挡） */
  HideComponents: 'hide-components',
  /** 保留某类构件（不隐藏，作参照） */
  KeepComponents: 'keep-components',
  /** 突出某个构件（高亮） */
  HighlightComponents: 'highlight-components',
  /** 换目标并重解 */
  Retarget: 'retarget',
  /** 按**原意图**重新求解机位（不换目标、不改意图、不动内容） */
  ReSolve: 're-solve',
} as const;
export type EditCommandKind = (typeof EditCommandKind)[keyof typeof EditCommandKind];

export interface EditCommand {
  kind: EditCommandKind;
  /** **哪一步**。null 表示「当前选中的那一步」；「第N步」会在这里给出 1 起的序号。 */
  stepIndex: number | null;
  /** 涉及哪些构件（按语义匹配出来的真实组件 ID）。 */
  componentIds: ComponentId[];
  /** 附带参数（时长毫秒、意图类型、运镜角度、旁白文本等），按 kind 解释。 */
  payload?: Record<string, unknown>;
  /** 解析置信度 0~1 */
  confidence: number;
  /** 人类可读的解释，用于界面回显「我是这么理解的」 */
  rationale: string;
}

export interface ParseResult {
  commands: EditCommand[];
  /** 是否听懂。false 时界面应提示换一种说法，**不要擅自执行任何东西**。 */
  recognized: boolean;
  /** 全部命中的证据（即使没形成指令也保留，便于调试与论文记录） */
  evidence: string[];
}

// ── 语义匹配：把「斗拱」「柱子」「屋顶」映射到真实构件 ────────────

/**
 * 中文口语词 → 构件类型。
 *
 * **为什么是硬编码的几十个词而不是分词 + 向量匹配**：讲解场景里的名词是很收敛的
 * 一套古建术语，硬编码词表既准确又可解释（「我把『檐柱』理解成了 column」）。
 * 词表外的词命中不了，结果是「没听懂」而不是「猜错了」——这是可以接受的。
 */
const KIND_WORDS: Array<{ kind: string; words: string[] }> = [
  { kind: 'dougong', words: ['斗拱', '斗栱', '铺作', '斗拱层'] },
  { kind: 'column', words: ['柱子', '檐柱', '金柱', '立柱', '柱', '柱子'] },
  { kind: 'columnbase', words: ['柱础', '柱墩', '础石'] },
  { kind: 'beam', words: ['梁', '横梁', '抬梁', '大梁', '柱梁'] },
  { kind: 'purlin', words: ['檩条', '檩', '桁', '脊檩', '檐檩'] },
  { kind: 'rafter', words: ['椽', '椽子', '檐椽', '飞椽'] },
  { kind: 'roof', words: ['屋顶', '屋面', '瓦面', '房顶'] },
  { kind: 'ridge', words: ['正脊', '屋脊', '脊'] },
  { kind: 'gable', words: ['山墙', '山面'] },
  { kind: 'plinth', words: ['台基', '基座', '台阶', '地台'] },
];

/** 方位词 → 站位（'e' / 'w' / 'c'）。 */
const SIDE_WORDS: Array<{ side: string; words: string[] }> = [
  { side: 'e', words: ['东侧', '东边', '东面', '东向', '左侧'] },
  { side: 'w', words: ['西侧', '西边', '西面', '西向', '右侧'] },
  { side: 'c', words: ['中间', '中央', '正中', '当中'] },
];

/** 檐面词 → 站位（'front' / 'back'）。 */
const EAVE_WORDS: Array<{ eave: string; words: string[] }> = [
  { eave: 'front', words: ['前檐', '正面', '前面', '南侧'] },
  { eave: 'back', words: ['后檐', '背面', '后面', '北侧'] },
];

/** 从一句话里找出它想指的类型（可能有多个，如「斗拱和屋檐」）。 */
export function matchKinds(text: string): string[] {
  const found: string[] = [];
  for (const { kind, words } of KIND_WORDS) {
    if (words.some((w) => text.includes(w)) && !found.includes(kind)) found.push(kind);
  }
  return found;
}

/** 从一句话里找方位限定（东侧/西侧/中间 + 前檐/后檐）。 */
export function matchLocators(text: string): { sides: string[]; eaves: string[] } {
  const sides = SIDE_WORDS.filter(({ words }) => words.some((w) => text.includes(w))).map((s) => s.side);
  const eaves = EAVE_WORDS.filter(({ words }) => words.some((w) => text.includes(w))).map((s) => s.eave);
  return { sides, eaves };
}

/**
 * 把「类型 + 方位」解析成真实的构件 ID 列表。
 *
 * 匹配不上任何构件时返回空数组（调用方据此判定「听不懂」）。**不做模糊兜底**——
 * 宁可不改，也不要改错构件。
 */
export function resolveComponents(
  kinds: string[],
  locators: { sides: string[]; eaves: string[] },
  scene: SceneSummary | null,
): ComponentId[] {
  if (!scene || kinds.length === 0) return [];
  const out: ComponentId[] = [];
  for (const c of scene.components) {
    if (!c.visible) continue;
    if (!kinds.includes(c.semantics.kind)) continue;
    const part = c.semantics.part ?? '';
    // 方位限定：作者说了方位就必须对上；一个字都没说则整类全收
    if (locators.sides.length > 0 || locators.eaves.length > 0) {
      const sideOk = locators.sides.length === 0 || part.split('_').some((seg) => locators.sides.includes(seg));
      const eaveOk = locators.eaves.length === 0 || part.split('_').some((seg) => locators.eaves.includes(seg));
      if (!sideOk || !eaveOk) continue;
    }
    if (!out.includes(c.id)) out.push(c.id);
  }
  return out;
}

// ── 动词识别 ───────────────────────────────────────────────────

const MOVE_WORDS = ['放到', '移到', '挪到', '调到', '放在', '排到', '挪去', '移去'];
const DELETE_WORDS = ['删掉', '删除', '去掉', '移除', '不要这一步', '删去'];
const DUPLICATE_WORDS = ['复制', '再复制一份', '复制一份', '拷贝'];
const HIDE_WORDS = ['隐藏', '藏起来', '不要显示', '不显示', '别显示', '去掉这个构件'];
const KEEP_WORDS = ['保留', '不要隐藏', '别隐藏', '留着', '保持可见', '当作参照', '作为参照'];

/**
 * 「别把它藏起来」这类**否定式**表达。
 *
 * ⚠️ 这是本解析器最容易出错的一处：「不要把柱子隐藏掉」里**同时**含「不要」与
 * 「隐藏」，如果按「有没有出现『隐藏』」判断，结论会正好反过来——把作者明确
 * 要求保留的东西藏了。因此否定判定必须**优先于** `HIDE_WORDS`，且要允许
 * 否定词与动词之间插入被否定的对象（「不要把柱子隐藏掉」中间隔了「把柱子」）。
 *
 * 覆盖的写法：不要/别/不用/不必/勿 + 最多 8 个字符 + 隐藏类动词。
 */
export const HIDE_NEGATION_PATTERN = /(不要|别|不用|不必|勿|莫)[^，。；,.!?]{0,8}(隐藏|藏起来|不显示|去掉|移除)/;
const HIGHLIGHT_WORDS = ['高亮', '突出', '强调一下这个', '标出来', '点亮'];
const NARRATION_WORDS = ['旁白改成', '改成讲', '这一句改成', '文字改成', '讲解词改成', '说的是'];
const DURATION_WORDS = ['时长', '停', '停留', '持续', '秒'];

/**
 * 意图词 → 意图类型。
 *
 * ⚠️ **顺序是有意义的，`priority` 更是**：一句话常同时命中好几类词——
 * 「这里重点讲一下斗拱和屋檐的支撑关系」里既有「重点讲」（→强调）又有
 * 「支撑/关系」（→揭示关系）。此时结论应当是**揭示关系**：作者说的是
 * 「讲两者的关系」，而不是「强调某一个」。
 *
 * 因此每一类除了默认权重还有一个 `priority`，**具体性更高的优先**：
 * `REVEAL_RELATION`（要同时看到两端，约束最强）> `KEEP_CONTEXT` >
 * `SHOW_OVERVIEW` > `REDUCE_OCCLUSION` > `EMPHASIZE`（最泛的默认项）。
 */
const INTENT_WORD_MAP: Array<{ kind: IntentKind; words: string[]; priority: number }> = [
  { kind: 'REVEAL_RELATION', words: ['关系', '连接', '承托', '搭接', '之间', '支撑', '受力'], priority: 5 },
  { kind: 'KEEP_CONTEXT', words: ['保留结构', '保留上下文', '留作参照', '整体结构', '保留周围'], priority: 4 },
  { kind: 'SHOW_OVERVIEW', words: ['俯瞰', '鸟瞰', '整体', '全局', '概览', '全景', '大局'], priority: 3 },
  { kind: 'REDUCE_OCCLUSION', words: ['减少遮挡', '看不到', '看不清', '被挡住', '遮挡'], priority: 2 },
  { kind: 'EMPHASIZE', words: ['强调', '突出', '重点讲', '重点看', '重点介绍'], priority: 1 },
];

/** 抽取时长（毫秒）。「3 秒」→ 3000；「停 2 秒」→ 2000。 */
export function extractDurationMs(text: string): number | null {
  const s = text.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10));
  const m = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(秒|s|毫秒|ms)/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const isMs = m[2].toLowerCase() === '毫秒' || m[2].toLowerCase() === 'ms';
  return Math.round(isMs ? value : value * 1000);
}

/** 抽取运镜角度。「绕一圈」「环绕一周」→ 360；「转半圈」→ 180；「转 90 度」→ 90。 */
export function extractMotionDegrees(text: string): number | null {
  if (/一圈|一周|360|整圈/.test(text)) return 360;
  if (/半圈|半周|180/.test(text)) return 180;
  const s = text.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10));
  const m = s.match(/(-?[0-9]+)\s*度/);
  if (m) {
    const deg = Number(m[1]);
    if (Number.isFinite(deg) && deg !== 0 && Math.abs(deg) <= 720) return deg;
  }
  return null;
}

// ── 主入口 ─────────────────────────────────────────────────────

/**
 * 解析一条自然语言指令。
 *
 * **一条输入可能产出多条指令**（「把斗拱放到第二步，并且不要隐藏柱子」是两句）。
 * 每条独立判定置信度；全部低于阈值时 `recognized: false`。
 */
export function parseEditInstruction(text: string, context: ParseContext): ParseResult {
  const raw = text.trim();
  const evidence: string[] = [];
  if (!raw) return { commands: [], recognized: false, evidence };

  const commands: EditCommand[] = [];

  // ★ 按标点与连接词切句。作者常一口气说两件事。
  //   只按「，。；、,.;」与「并且/然后/再/同时」切，避免把「斗拱和屋檐」这种
  //   并列名词切开（它们没有出现在连接词表里）。
  const clauses = raw
    .split(/[，。；！？,.;!?]+|并且|然后|同时|接着/)
    .map((c) => c.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    const parsed = parseClause(clause, context);
    if (parsed) {
      commands.push(parsed.command);
      evidence.push(...parsed.evidence);
    }
  }

  const recognized = commands.some((c) => c.confidence >= MIN_COMMAND_CONFIDENCE);
  return {
    commands: recognized ? commands.filter((c) => c.confidence >= MIN_COMMAND_CONFIDENCE) : [],
    recognized,
    evidence,
  };
}

export interface ParseContext {
  scene: SceneSummary | null;
  /** 当前分镜（「第二步」的序号即在此定位） */
  storyboard: Storyboard;
  /** 当前激活的步骤 id（指令里没提序号时指它） */
  activeStepId: string | null;
  labelOf(id: ComponentId): string;
}

interface ClauseParse {
  command: EditCommand;
  evidence: string[];
}

/** 解析单个分句。认不出来返回 null。 */
function parseClause(clause: string, context: ParseContext): ClauseParse | null {
  const ordinal = extractOrdinal(clause);
  const has = (words: string[]): string | null => words.find((w) => clause.includes(w)) ?? null;

  // ── ① 顺序调整：「把斗拱放到第二步」 ──
  //
  // ⚠️ 这句话里有**两个**位置信息：源（「斗拱」所在的步骤）与目标（「第二步」）。
  //    只取一个是不够的——这正是这类指令比「删除第 3 步」难的地方。
  //    源优先按构件名去找（「斗拱那一步」），找不到再退化为「当前选中的步骤」。
  const moveWord = has(MOVE_WORDS);
  if (moveWord && ordinal !== null) {
    const kinds = matchKinds(clause);
    const locators = matchLocators(clause);
    const ids = resolveComponents(kinds, locators, context.scene);
    const sourceIndex = ids.length > 0 ? findStepIndexByTarget(context.storyboard, ids) : indexOfActive(context);
    const sourceText = sourceIndex !== null
      ? `第 ${sourceIndex} 步`
      : ids.length > 0
        ? '（提到了构件，但没有任何步骤以它为讲解目标）'
        : '当前步骤';
    return {
      command: {
        kind: EditCommandKind.MoveStep,
        stepIndex: ordinal,
        componentIds: ids,
        payload: { sourceStepIndex: sourceIndex },
        confidence: sourceIndex !== null ? 0.88 : 0.5,
        rationale: `把${sourceText}移到第 ${ordinal} 步（动词「${moveWord}」+ 序号「${toChineseNumber(ordinal)}」）`,
      },
      evidence: [`动词「${moveWord}」+ 序号 ${ordinal}`, kinds.length > 0 ? `源构件类型 ${kinds.join('/')}` : '未给出源构件'],
    };
  }

  // ── ② 删除 ──
  const deleteWord = has(DELETE_WORDS);
  if (deleteWord) {
    const stepIndex = ordinal ?? indexOfActive(context);
    return {
      command: {
        kind: EditCommandKind.DeleteStep,
        stepIndex,
        componentIds: [],
        confidence: stepIndex !== null ? 0.85 : 0.5,
        rationale: stepIndex !== null
          ? `删除第 ${stepIndex} 步（动词「${deleteWord}」）`
          : `删除当前步骤（动词「${deleteWord}」，但没指明是哪一步、也没有选中步骤）`,
      },
      evidence: [`动词「${deleteWord}」`],
    };
  }

  // ── ③ 复制 ──
  const dupWord = has(DUPLICATE_WORDS);
  if (dupWord) {
    const stepIndex = ordinal ?? indexOfActive(context);
    return {
      command: {
        kind: EditCommandKind.DuplicateStep,
        stepIndex,
        componentIds: [],
        confidence: stepIndex !== null ? 0.85 : 0.5,
        rationale: stepIndex !== null ? `复制第 ${stepIndex} 步` : '复制当前步骤',
      },
      evidence: [`动词「${dupWord}」`],
    };
  }

  // ── ④ 保留（必须先于隐藏判断）──
  //
  // ⚠️ 两条路要一起判：
  //   ① 出现「保留 / 留着 / 保持可见」等**肯定式**词；
  //   ② 出现「不要把 X 隐藏」这种**否定式**——词表匹配不到它（中间隔着「把柱子」），
  //      但它的语义与「保留」完全一致。漏判的后果是把作者明确要留的东西藏掉。
  const keepWord = has(KEEP_WORDS);
  const hideNegated = HIDE_NEGATION_PATTERN.test(clause);
  if (keepWord || hideNegated) {
    const kinds = matchKinds(clause);
    const locators = matchLocators(clause);
    const ids = resolveComponents(kinds, locators, context.scene);
    const confidence = ids.length > 0 ? 0.86 : 0.45;
    const why = keepWord ? `"${keepWord}"` : '否定式「不要…隐藏」';
    return {
      command: {
        kind: EditCommandKind.KeepComponents,
        stepIndex: ordinal ?? indexOfActive(context),
        componentIds: ids,
        confidence,
        rationale: ids.length > 0
          ? `让 ${ids.map((id) => context.labelOf(id)).join('、')} 保持可见（${why}）`
          : `想保留某些构件，但没识别出是哪些`,
      },
      evidence: [keepWord ? `动词「${keepWord}」` : '否定式隐藏 → 保留', kinds.length > 0 ? `类型 ${kinds.join('/')}` : '未识别类型'],
    };
  }

  // ── ⑤ 隐藏 ──
  const hideWord = has(HIDE_WORDS);
  if (hideWord) {
    const kinds = matchKinds(clause);
    const locators = matchLocators(clause);
    const ids = resolveComponents(kinds, locators, context.scene);
    return {
      command: {
        kind: EditCommandKind.HideComponents,
        stepIndex: ordinal ?? indexOfActive(context),
        componentIds: ids,
        confidence: ids.length > 0 ? 0.84 : 0.45,
        rationale: ids.length > 0
          ? `隐藏 ${ids.map((id) => context.labelOf(id)).join('、')}（"${hideWord}"）`
          : `想隐藏某些构件，但没识别出是哪些`,
      },
      evidence: [`动词「${hideWord}」`, kinds.length > 0 ? `类型 ${kinds.join('/')}` : '未识别类型'],
    };
  }

  // ── ⑥ 高亮 ──
  const hlWord = has(HIGHLIGHT_WORDS);
  if (hlWord) {
    const kinds = matchKinds(clause);
    const locators = matchLocators(clause);
    const ids = resolveComponents(kinds, locators, context.scene);
    return {
      command: {
        kind: EditCommandKind.HighlightComponents,
        stepIndex: ordinal ?? indexOfActive(context),
        componentIds: ids,
        confidence: ids.length > 0 ? 0.84 : 0.45,
        rationale: ids.length > 0
          ? `高亮 ${ids.map((id) => context.labelOf(id)).join('、')}`
          : '想高亮某些构件，但没识别出是哪些',
      },
      evidence: [`动词「${hlWord}」`],
    };
  }

  // ── ⑦ 意图类型 ──
  //
  // 把所有命中的意图词都收集起来，按 `priority` 取最具体的那一类——
  // 而不是取词表里第一个命中的（那会让「重点讲…的支撑关系」误判成强调）。
  const intentHits = INTENT_WORD_MAP
    .map(({ kind, words, priority }) => ({ kind, priority, hit: has(words) }))
    .filter((h): h is { kind: IntentKind; priority: number; hit: string } => h.hit !== null)
    .sort((a, b) => b.priority - a.priority);

  if (intentHits.length > 0) {
    const winner = intentHits[0];
    const kinds = matchKinds(clause);
    const locators = matchLocators(clause);
    const ids = resolveComponents(kinds, locators, context.scene);
    const others = intentHits.slice(1).map((h) => INTENT_LABELS[h.kind]);
    return {
      command: {
        kind: EditCommandKind.SetIntent,
        stepIndex: ordinal ?? indexOfActive(context),
        componentIds: ids,
        payload: { intentKind: winner.kind },
        confidence: 0.78,
        rationale: others.length > 0
          ? `把意图设为「${INTENT_LABELS[winner.kind]}」（命中词「${winner.hit}」；这句里也出现了 ${others.join('、')} 类的词，但「${INTENT_LABELS[winner.kind]}」更具体，所以按它处理）`
          : `把这一步的意图设为「${INTENT_LABELS[winner.kind]}」（命中词「${winner.hit}」）`,
      },
      evidence: intentHits.map((h) => `意图词「${h.hit}」→ ${h.kind}`),
    };
  }

  // ── ⑧ 运镜 ──
  if (/环绕|绕.{0,3}一圈|转一圈|绕建筑|旋转/.test(clause)) {
    const degrees = extractMotionDegrees(clause);
    if (degrees !== null) {
      return {
        command: {
          kind: EditCommandKind.SetMotion,
          stepIndex: ordinal ?? indexOfActive(context),
          componentIds: [],
          payload: { degrees },
          confidence: 0.86,
          rationale: `设置运镜：环绕 ${degrees}°`,
        },
        evidence: ['动词「环绕/转圈」+ 角度'],
      };
    }
  }

  // ── ⑨ 时长 ──
  const durationMs = extractDurationMs(clause);
  if (durationMs !== null && has(DURATION_WORDS)) {
    return {
      command: {
        kind: EditCommandKind.SetDuration,
        stepIndex: ordinal ?? indexOfActive(context),
        componentIds: [],
        payload: { durationMs },
        confidence: 0.8,
        rationale: `把这一步的时长改为 ${(durationMs / 1000).toFixed(1)} 秒`,
      },
      evidence: [`时长 ${durationMs}ms`],
    };
  }

  // ── ⑩ 旁白改写 ──
  const narrationWord = has(NARRATION_WORDS);
  if (narrationWord) {
    const after = clause.slice(clause.indexOf(narrationWord) + narrationWord.length).replace(/^[「“"'：:\s]+/, '');
    if (after.length > 0) {
      return {
        command: {
          kind: EditCommandKind.SetNarration,
          stepIndex: ordinal ?? indexOfActive(context),
          componentIds: [],
          payload: { narration: after.replace(/[」”"']$/, '') },
          confidence: 0.75,
          rationale: `把旁白改成「${after}」`,
        },
        evidence: [`旁白改写词「${narrationWord}」`],
      };
    }
  }

  return null;
}

/** 「当前步骤」的 1 起序号；没有激活步骤时返回 null。 */
function indexOfActive(context: ParseContext): number | null {
  if (!context.activeStepId) return null;
  const index = context.storyboard.steps.findIndex((s) => s.id === context.activeStepId);
  return index >= 0 ? index + 1 : null;
}

/**
 * 找出「以这些构件中的任意一个为讲解目标」的那一步（1 起序号）。
 *
 * 用途：「把斗拱放到第二步」里，「斗拱」指的是**哪一步在讲它**——这是一个
 * 反向查找（从构件找步骤），而不是从步骤找构件。多个命中时取**最早**的那一步
 * （分镜里同一个构件很少被讲两遍，取最早的是稳妥选择）。
 */
export function findStepIndexByTarget(storyboard: Storyboard, componentIds: ComponentId[]): number | null {
  if (componentIds.length === 0) return null;
  for (let i = 0; i < storyboard.steps.length; i += 1) {
    const step = storyboard.steps[i];
    if (targetRefsAny(step.target, componentIds)) return i + 1;
  }
  return null;
}

/** 步骤的目标里是否包含这些构件中的任意一个。 */
function targetRefsAny(target: TargetRef, componentIds: ComponentId[]): boolean {
  const ids = target.form === 'single' ? [target.component.id] : [target.from.id, target.to.id];
  return ids.some((id) => componentIds.includes(id));
}

/** 把 1 起序号解析成步骤对象（越界返回 null）。 */
export function stepAtOrdinal(context: ParseContext, ordinal: number | null, activeFallback = true): StoryboardStep | null {
  const steps: StoryboardStep[] = context.storyboard.steps;
  if (ordinal !== null) {
    const index = ordinal - 1;
    return steps[index] ?? null;
  }
  if (!activeFallback || !context.activeStepId) return null;
  return steps.find((s) => s.id === context.activeStepId) ?? null;
}

/**
 * 目标引用 → 单个构件（关系型取第一端）。供 `Retarget` 类指令使用。
 */
export function firstTargetId(target: TargetRef): ComponentId | null {
  return target.form === 'single' ? target.component.id : target.from.id;
}
