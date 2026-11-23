/**
 * 分镜与步骤类型
 * 依据：《项目概要设计文档》§5.6、§5.7、§5.8；原始草案见 `note/storyboard数据结构.txt`。
 *
 * **这张表里最重要的字段是 `SolveState.Stale`**（概要设计 §5.6）：
 * 它是「意图可迁移」这件事在数据层的证据——当一个步骤的 `target` 被换掉、
 * 而 `camera` 还是旧的时，系统**知道**自己处于「意图已更新、实现待重算」的
 * 状态。Navisworks 的视点没有任何等价状态：它的视点就是一个静态快照。
 */
import type { Pose } from './geometry.ts';
import type { ComponentId } from './component.ts';
import type { VisualEffects } from './solver.ts';
import type { TargetRef } from './solver.ts';
import type { VisualIntent, IntentPrediction, IntentSignal } from './intent.ts';

// ── §5.6 求解状态 ──────────────────────────────────────────────
export const SolveState = {
  /** 尚未求解（如手工创建但未定机位） */
  None: 'none',
  /** 已求解且与当前 target/intent 一致 */
  Solved: 'solved',
  /** target 或 intent 变了，camera 是旧的，需要重解 */
  Stale: 'stale',
  /** 求解失败或保真度过低（FR-19） */
  Failed: 'failed',
} as const;
export type SolveState = (typeof SolveState)[keyof typeof SolveState];

export const SOLVE_STATE_LABELS: Record<SolveState, string> = {
  none: '未求解',
  solved: '已求解',
  stale: '待重算',
  failed: '求解失败',
};

// ── §5.6 转场 ──────────────────────────────────────────────────
export const TransitionKind = {
  /** 瞬切 */
  Cut: 'cut',
  /** 平滑过渡 */
  Smooth: 'smooth',
} as const;
export type TransitionKind = (typeof TransitionKind)[keyof typeof TransitionKind];

export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  cut: '瞬切',
  smooth: '平滑',
};

// ── §5.6 步骤 ──────────────────────────────────────────────────
export interface StoryboardStep {
  id: string;
  title: string;
  /** ① 旁白：步骤的一等字段，不是渲染产物（任务一 §2.5 空位①） */
  narration: string;
  /** ② 目标：引用而非快照 */
  target: TargetRef;
  /** ③ 意图：这一步想达成什么。null 表示尚未确定意图 */
  intent: VisualIntent | null;
  /** ④ 相机：当前已知的最优解。可能因未求解或已失效而为 null */
  camera: Pose | null;
  /** ⑤ 视觉效果 */
  effects: VisualEffects;
  /** ⑥ 时长与转场 */
  durationMs: number;
  transition: TransitionKind;
  /** 求解状态：让系统能区分「还没解」「解过但目标变了」「解好了」 */
  solve: SolveState;
  /** 最近一次求解留给用户的说明（失败原因、保真度分数等），供 UI 展示 */
  solveNote?: string;
}

// ── §5.6 分镜 ──────────────────────────────────────────────────
export interface StoryboardModelRef {
  name: string;
  componentCount: number;
  modelPrefix: string;
}

export interface Storyboard {
  id: string;
  title: string;
  steps: StoryboardStep[];
  /** 记录分镜是从哪个模型做的——加载到不同模型上时可提示不兼容（支撑 C-3） */
  modelRef?: StoryboardModelRef;
  /** 存档兼容用 */
  schemaVersion: number;
  /** 作者、备注等自由字段 */
  meta?: StoryboardMeta;
}

export interface StoryboardMeta {
  author?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ── §5.7 示范记录与意图预测 ────────────────────────────────────
export type DemoAction =
  | { at: number; type: 'select'; componentId: ComponentId }
  | { at: number; type: 'deselect' }
  | { at: number; type: 'camera'; pose: Pose }
  | { at: number; type: 'opacity'; componentId: ComponentId; value: number }
  | { at: number; type: 'visibility'; componentId: ComponentId; value: boolean }
  | { at: number; type: 'highlight'; componentId: ComponentId; value: boolean };

export interface DemoRecord {
  id: string;
  /** 操作序列。每步只记「发生了什么变化」，不记全量状态 */
  actions: DemoAction[];
  startedAt: number;
  endedAt: number;
  /** 示范发生在哪个模型上 */
  modelPrefix: string;
}

/**
 * 从示范记录提取出的「结束状态」。
 *
 * 概要设计 §5.7 只用 `actions` 描述示范，但推断（M7）真正需要的是「作者最终把
 * 场景弄成了什么样」——把 actions 归约成这个形状，规则就只需读一个对象，
 * 而不用自己重放一遍。**归约逻辑在 L2（`runtime/demo/`），因为只有它知道
 * 场景对象的当前状态**；L3 只消费结果。
 */
export interface DemoOutcome {
  /** 最终被选中的构件 */
  selectedId: ComponentId | null;
  /** 结束时各部分透明度（只含有别于 1 的） */
  opacities: Record<ComponentId, number>;
  /** 结束时的隐藏集合 */
  hidden: ComponentId[];
  /** 结束时的高亮集合 */
  highlighted: ComponentId[];
  /** 相机位姿的变化轨迹（首尾最重要，中间用于判断是否绕行） */
  cameraTrack: Pose[];
  /** 记录期间「被操作过」的构件，用于判断讲解焦点 */
  touchedIds: ComponentId[];
}

export interface PredictionBundle {
  predictions: IntentPrediction[];
  /** 是否识别出明确意图。false 时 UI 应引导用户手动选择（§6.1 失败处理） */
  recognized: boolean;
  /** 全部信号，即使没有匹配上任何规则也保留，便于调试与论文记录 */
  signals: IntentSignal[];
  outcome: DemoOutcome;
}

// ── 步骤工厂与不变量 ───────────────────────────────────────────
import { makeId } from '../../core/id.ts';
import { EMPTY_EFFECTS } from './solver.ts';

export const DEFAULT_STEP_DURATION_MS = 4000;

/**
 * 新建一个「空白」步骤。
 *
 * 注意 `solve: 'none'` 与 `camera: null` 的组合是**有意的**：一个还没有机位的
 * 步骤应当是「未求解」而不是「求解失败」。播放时二者提示完全不同（§6.3）。
 */
export function createStep(target: TargetRef, title = '新步骤'): StoryboardStep {
  return {
    id: makeId('step'),
    title,
    narration: '',
    target,
    intent: null,
    camera: null,
    effects: { ...EMPTY_EFFECTS, highlight: [], transparent: [], hidden: [] },
    durationMs: DEFAULT_STEP_DURATION_MS,
    transition: 'smooth',
    solve: 'none',
  };
}

export function createStoryboard(title = '未命名分镜'): Storyboard {
  return {
    id: makeId('sb'),
    title,
    steps: [],
    schemaVersion: 1,
    meta: {},
  };
}
