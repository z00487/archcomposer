/**
 * 求解与保真度的数据契约
 * 依据：《项目概要设计文档》§5.8、《项目概要设计文档》§4.2.2 / §4.2.3。
 *
 * **这一组接口是本项目「可替换求解器」（约束 C-2）与「不许静默降级」
 * （FR-19）的落点。**
 */
import type { Aabb, Pose, Vec3 } from './geometry.ts';
import type { ComponentSemantics } from './component.ts';
import type { ComponentId } from './component.ts';
import type { VisualIntent } from './intent.ts';

// ── 目标引用（§5.4）────────────────────────────────────────────
export const RelationKind = {
  Lap: 'lap', // 搭接
  Bear: 'bear', // 承托
  Stacked: 'stacked', // 上下相邻
  Aligned: 'aligned', // 并列
} as const;
export type RelationKind = (typeof RelationKind)[keyof typeof RelationKind];

export const RELATION_LABELS: Record<RelationKind, string> = {
  lap: '搭接',
  bear: '承托',
  stacked: '上下相邻',
  aligned: '并列',
};

export interface SingleTarget {
  form: 'single';
  component: { id: ComponentId; semantics: ComponentSemantics };
}

export interface RelationTarget {
  form: 'relation';
  /** 关系两端（第一版限两个，为 REVEAL_RELATION 服务） */
  from: { id: ComponentId; semantics: ComponentSemantics };
  to: { id: ComponentId; semantics: ComponentSemantics };
  relation: RelationKind;
}

export type TargetRef = SingleTarget | RelationTarget;

/** 取出目标引用的全部构件 ID（单目标是 1 个，关系目标是 2 个）。 */
export function targetIds(target: TargetRef): ComponentId[] {
  return target.form === 'single'
    ? [target.component.id]
    : [target.from.id, target.to.id];
}

/** 目标引用人类可读描述。 */
export function describeTarget(
  target: TargetRef,
  labelOf: (id: ComponentId) => string,
): string {
  if (target.form === 'single') return labelOf(target.component.id);
  return `${labelOf(target.from.id)} 与 ${labelOf(target.to.id)} 的${RELATION_LABELS[target.relation]}`;
}

// ── 视觉效果（§5.6）────────────────────────────────────────────
export interface TransparentEntry {
  id: ComponentId;
  opacity: number;
}

export interface VisualEffects {
  /** 高亮 */
  highlight: ComponentId[];
  /** 半透明（用于「减少遮挡」） */
  transparent: TransparentEntry[];
  /** 隐藏 */
  hidden: ComponentId[];
}

export const EMPTY_EFFECTS: VisualEffects = { highlight: [], transparent: [], hidden: [] };

/** 深拷贝视觉效果。播放与编辑都要拿到独立副本，避免共享引用被就地改动。 */
export function cloneEffects(e: VisualEffects): VisualEffects {
  return {
    highlight: [...e.highlight],
    transparent: e.transparent.map((t) => ({ ...t })),
    hidden: [...e.hidden],
  };
}

// ── §5.8 场景摘要（L2 → L3 的唯一数据通道）──────────────────────
/**
 * **为什么不把整个 Three.js 场景传给求解器**：约束 C-1。求解器只需要包围盒、
 * 可见性、语义这三样；传 Mesh 会让 L3 依赖 L2，整个分层就白做了。
 *
 * `worldMatrix` 不在这里——构件在模型里已烘焙好位置（生成器保证），因此
 * AABB 就是世界坐标下的。若将来支持层级变换，这里要补一个世界矩阵字段。
 */
export interface SceneComponent {
  id: ComponentId;
  semantics: ComponentSemantics;
  aabbMin: Vec3;
  aabbMax: Vec3;
  visible: boolean;
  /** 是否可作替换候选（不等于 REPLACEABLE_KINDS 的构件为 false） */
  replaceable: boolean;
}

export interface SceneSummary {
  components: SceneComponent[];
  /** 场景整体包围盒，用于采样范围 */
  boundsMin: Vec3;
  boundsMax: Vec3;
  /** 视口宽高比，投影计算需要 */
  aspect: number;
  /** 收集该摘要时的模型前缀，用于校验分镜与模型是否匹配 */
  modelPrefix: string;
}

export function sceneComponentAabb(c: SceneComponent): Aabb {
  return { min: c.aabbMin, max: c.aabbMax };
}

export function findSceneComponent(
  scene: SceneSummary,
  id: ComponentId,
): SceneComponent | null {
  return scene.components.find((c) => c.id === id) ?? null;
}

// ── §5.8 求解器接口 ────────────────────────────────────────────
export interface SolveRequest {
  target: TargetRef;
  intent: VisualIntent;
  /** 场景几何摘要：只给求解器需要的量 */
  scene: SceneSummary;
  /** 首次求解时的初始机位（通常来自示范）。求解器可把它当作候选之一 */
  seed?: Pose | null;
  /** 求解预算：候选数上限，用于控制 NFR-3 的 5 秒约束 */
  maxCandidates?: number;
}

/** ★ 必须显式表达成败，不允许沉默降级（FR-19）。 */
export interface SolveResult {
  ok: boolean;
  camera: Pose | null;
  effects: VisualEffects;
  /** 求解结果自带的保真度 */
  fidelity: FidelityReport;
  /** 失败或部分满足时的说明 */
  conflicts: ConstraintConflict[];
  /** 求解器名，便于评估时区分算法版本 */
  solver: string;
  /** 实际考察的候选数，供论文的耗时统计使用 */
  evaluated: number;
}

export interface ConstraintConflict {
  /** 哪个谓词没被满足 */
  measure: string;
  /** 实际达到的值 */
  achieved: number;
  /** 要求（如 ">= 0.25"） */
  required: string;
  /** 如「两个目标构件距离过远，无法同时同框」 */
  note?: string;
}

export interface FidelityReport {
  /** 0~1 总体保真度 */
  overall: number;
  perPredicate: Array<{ measure: string; score: number; weight: number }>;
  conflicts: ConstraintConflict[];
}

/**
 * 求解器接口（约束 C-2：必须可替换）。
 *
 * 实现族注册在 `domain/solver/registry.ts` 的 `SolverRegistry` 里，按名取用。
 * 第一版只实现「候选采样 + 打分」；将来把 CinemaTraj 风格的 SDF 优化器实现为
 * `SdfRefineSolver` 插进来即可，调用方（M11 commands）一行都不用改。
 */
export interface ViewSolver {
  readonly name: string;
  solve(request: SolveRequest): SolveResult;
}

// ── §5.5 谓词求值与保真度（M9 的输入形状）──────────────────────
export interface PredicateEvaluation {
  predicate: import('./intent.ts').IntentPredicate;
  /** 谓词在 [0,1] 上「满足得有多好」。布尔量退化为 0 / 1 */
  score: number;
  /** 该谓词依赖的实测原始量（如占比 = 0.081），供冲突报告与 UI 展示 */
  measured: number;
  /** 要求的中文描述 */
  required: string;
  satisfied: boolean;
}

export interface FidelityInput {
  intent: VisualIntent;
  /** 目标引用（给出谓词 subjects 为空时默认作用的构件） */
  target: TargetRef;
  pose: Pose;
  effects: VisualEffects;
  scene: SceneSummary;
}

export interface FidelityEvaluation {
  report: FidelityReport;
  evaluations: PredicateEvaluation[];
}
