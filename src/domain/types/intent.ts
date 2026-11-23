/**
 * 视觉意图类型
 * 依据：《项目概要设计文档》§5.5、《项目概要设计文档》§4.2.1。
 *
 * **这是本项目的核心数据结构。** 任务一 §1.2 的约束 C-5 说：「『意图』必须被表达为
 * 可计算的约束，否则无法度量满足程度」。本文件就是那条约束的代码形态。
 */
import type { Pose } from './geometry.ts';

// ── §5.5 意图类型表 ──────────────────────────────────────────────
export const IntentKind = {
  Emphasize: 'EMPHASIZE',
  ReduceOcclusion: 'REDUCE_OCCLUSION',
  KeepContext: 'KEEP_CONTEXT',
  RevealRelation: 'REVEAL_RELATION',
  ShowOverview: 'SHOW_OVERVIEW',
} as const;
export type IntentKind = (typeof IntentKind)[keyof typeof IntentKind];

export const INTENT_LABELS: Record<IntentKind, string> = {
  EMPHASIZE: '强调目标',
  REDUCE_OCCLUSION: '减少遮挡',
  KEEP_CONTEXT: '保留结构上下文',
  REVEAL_RELATION: '揭示构件关系',
  SHOW_OVERVIEW: '总体俯瞰',
};

export const INTENT_DESCRIPTIONS: Record<IntentKind, string> = {
  EMPHASIZE: '让目标构件在画面中占主导，且不被其它构件挡住',
  REDUCE_OCCLUSION: '目标保持可见，挡在前面的构件被调透明或隐藏',
  KEEP_CONTEXT: '目标因对比而凸显，周边结构保持可见、不被高亮',
  REVEAL_RELATION: '关系两端的构件同时入画，且二者间距在画面中可辨',
  SHOW_OVERVIEW: '以足够高的俯角把主要构件一次性纳入视野',
};

// ── §5.5 约束谓词：统一形状（「可测量量 + 比较符 + 阈值」）────────
/**
 * 为什么所有谓词都用同一个形状，而不是每类意图自定义字段（§5.5 的论证）：
 * 求解器（M8）与保真度模块（M9）都要对谓词做统一处理。若每类意图各有字段，
 * 这两个模块就得对意图类型做 `switch`，每加一类意图要改两处——违反 NFR-7。
 *
 * **实现上的直接后果**：本文件里没有任何 `switch (intent.kind)`。意图类型的
 * 区别只体现在「用了哪几个 measure」上（见 §5.5 的意图—谓词对照表）。
 */
export type MeasureName =
  | 'screenCoverage' // 目标在画面中的投影占比，0~1
  | 'unoccluded' // 目标视线方向上无遮挡物，0 或 1
  | 'visible' // 目标在视锥内，0 或 1
  | 'coVisible' // 两个构件同时在视锥内，0 或 1
  | 'screenDistance' // 两构件在画面中的归一化距离，0~√2
  | 'elevationRatio' // 相机相对目标的仰角比，-1~1（1 = 正上方）
  | 'contextVisible'; // 上下文构件保持可见的比例，0~1

export const MEASURE_LABELS: Record<MeasureName, string> = {
  screenCoverage: '画面占比',
  unoccluded: '无遮挡',
  visible: '可见',
  coVisible: '同时可见',
  screenDistance: '画面间距',
  elevationRatio: '俯角高度比',
  contextVisible: '上下文可见度',
};

/** 谓词的操作数形状。`in` 用区间，其余用标量。 */
export type PredicateValue =
  | { op: '>='; value: number }
  | { op: '<='; value: number }
  | { op: '=='; value: number }
  | { op: 'in'; value: [number, number] };

export interface IntentPredicate {
  measure: MeasureName;
  /** 该谓词作用于哪些构件。单目标意图为空数组（默认作用于步骤的 target）。 */
  subjects: string[];
  /** 目标值 */
  test: PredicateValue;
  /** 权重，用于加权求和。默认 1。 */
  weight: number;
}

// ── §5.5 来源与置信度 ────────────────────────────────────────────
export const IntentSource = {
  Demo: 'demo',
  Language: 'language',
  Manual: 'manual',
} as const;
export type IntentSource = (typeof IntentSource)[keyof typeof IntentSource];

export interface IntentProvenance {
  source: IntentSource;
  /** 0~1；`manual` 恒为 1 */
  confidence: number;
  /** 人类可读的推断理由，用于 UI 展示「系统为什么这么认为」 */
  rationale: string;
  /** 用户是否确认过。FR-14 要求确认，这里是确认的留痕 */
  confirmedByUser: boolean;
}

export interface VisualIntent {
  id: string;
  kind: IntentKind;
  predicates: IntentPredicate[];
  provenance: IntentProvenance;
}

// ── §5.7 推断信号 ────────────────────────────────────────────────
export type IntentSignalKind = 'selection' | 'opacity' | 'visibility' | 'camera' | 'language';

export interface IntentSignal {
  kind: IntentSignalKind;
  /** 人类可读，如「构件 X 被调至 20% 透明度」 */
  detail: string;
  weight: number;
}

export interface IntentPrediction {
  intent: VisualIntent;
  /** 该候选依据的「状态差异」摘要，用于向用户解释 */
  signals: IntentSignal[];
}

// ── §5.5 意图 → 谓词组合（第一版的五个模板）─────────────────────
/**
 * 阈值参数的默认值。
 *
 * 概要设计 §5.5 说明了这些数字的**来源**：第一版取「从示范记录里反推的经验值」
 * ——作者演示时那个位姿实际达到了多少，就把阈值设在略低于它的位置。这样做的
 * 好处是「自动把作者的偏好编码进意图」，不需要事先设魔法数字。
 *
 * 下面的默认值是**在没有示范时的兜底**（如用户手动选意图类型），因此取得比较
 * 保守。真实用例里 `derivePredicates` 会用示范实测值覆盖它们。
 */
export const INTENT_DEFAULTS = {
  /** EMPHASIZE 的画面占比下限。0.12 ≈ 目标撑满画面约 1/8 面积，肉眼可辨为「主体」 */
  emphasizeCoverage: 0.12,
  /** REVEAL_RELATION 的画面间距可辨区间，归一化 NDC 距离 */
  relationDistance: [0.12, 1.1] as [number, number],
  /** SHOW_OVERVIEW 的最低俯角高度比 */
  overviewElevation: 0.45,
  /** KEEP_CONTEXT 要求上下文可见的比例 */
  contextVisibleRatio: 1.0,
} as const;

/** 谓词构造的小工具，避免五个模板里重复写 `op/value` 的包装。 */
export const predicate = {
  coverageAtLeast(min: number, subjects: string[] = [], weight = 1): IntentPredicate {
    return { measure: 'screenCoverage', subjects, test: { op: '>=', value: min }, weight };
  },
  unoccluded(subjects: string[] = [], weight = 1): IntentPredicate {
    return { measure: 'unoccluded', subjects, test: { op: '==', value: 1 }, weight };
  },
  visible(subjects: string[] = [], weight = 1): IntentPredicate {
    return { measure: 'visible', subjects, test: { op: '==', value: 1 }, weight };
  },
  coVisible(subjects: string[], weight = 1): IntentPredicate {
    return { measure: 'coVisible', subjects, test: { op: '==', value: 1 }, weight };
  },
  screenDistanceIn(range: [number, number], subjects: string[], weight = 1): IntentPredicate {
    return { measure: 'screenDistance', subjects, test: { op: 'in', value: range }, weight };
  },
  elevationAtLeast(min: number, subjects: string[] = [], weight = 1): IntentPredicate {
    return { measure: 'elevationRatio', subjects, test: { op: '>=', value: min }, weight };
  },
  contextVisibleRatioAtLeast(min: number, subjects: string[], weight = 1): IntentPredicate {
    return { measure: 'contextVisible', subjects, test: { op: '>=', value: min }, weight };
  },
};

/**
 * 一个辅助函数：把「相对位置」翻译成屏幕距离区间的**下限修正**。
 * 两个构件在世界里离得越远，在画面中同框就越难。这个函数不改变意图，
 * 只用于在生成关系类意图时给出一个更合理的区间下限。
 */
export function relationDistanceRange(worldGap: number): [number, number] {
  const lo = INTENT_DEFAULTS.relationDistance[0];
  const hi = INTENT_DEFAULTS.relationDistance[1];
  // 世界间隙越大，允许的画面下限略微放宽（0.12 → 最多 0.3）
  return [Math.min(lo + worldGap * 0.02, 0.3), hi];
}

/** 供 UI 展示：把一条谓词渲染成中文句子，如「画面占比 ≥ 12%」。 */
export function describePredicate(p: IntentPredicate, labelOf: (id: string) => string): string {
  const subjectText =
    p.subjects.length === 0 ? '目标' : p.subjects.map(labelOf).join(' 与 ');
  const measure = MEASURE_LABELS[p.measure];
  switch (p.test.op) {
    case '>=':
      return `${subjectText}的${measure} ≥ ${formatMeasure(p.measure, p.test.value)}`;
    case '<=':
      return `${subjectText}的${measure} ≤ ${formatMeasure(p.measure, p.test.value)}`;
    case '==':
      if (p.measure === 'unoccluded') return `${subjectText}无遮挡`;
      if (p.measure === 'visible') return `${subjectText}在画面内`;
      if (p.measure === 'coVisible') return `${subjectText}同时入画`;
      return `${subjectText}的${measure} = ${formatMeasure(p.measure, p.test.value)}`;
    case 'in':
      return `${subjectText}的画面间距在 ${formatMeasure(p.measure, p.test.value[0])} ~ ${formatMeasure(p.measure, p.test.value[1])} 之间`;
    default:
      return `${subjectText}的${measure}`;
  }
}

function formatMeasure(measure: MeasureName, value: number): string {
  if (measure === 'screenCoverage' || measure === 'contextVisible') {
    return `${Math.round(value * 100)}%`;
  }
  if (measure === 'visible' || measure === 'unoccluded' || measure === 'coVisible') {
    return value === 1 ? '满足' : `${value}`;
  }
  return value.toFixed(2);
}

/** 意图的默认谓词组合（§5.5 对照表）。`subjects` 为空表示「作用于步骤的 target」。 */
export function defaultPredicatesFor(kind: IntentKind, subjects: string[] = []): IntentPredicate[] {
  switch (kind) {
    case IntentKind.Emphasize:
      return [
        predicate.coverageAtLeast(INTENT_DEFAULTS.emphasizeCoverage, subjects),
        predicate.unoccluded(subjects),
      ];
    case IntentKind.ReduceOcclusion:
      return [predicate.unoccluded(subjects), predicate.visible(subjects)];
    case IntentKind.KeepContext:
      return [
        predicate.contextVisibleRatioAtLeast(INTENT_DEFAULTS.contextVisibleRatio, subjects),
        predicate.unoccluded(),
      ];
    case IntentKind.RevealRelation:
      return [
        predicate.coVisible(subjects),
        predicate.screenDistanceIn([...INTENT_DEFAULTS.relationDistance], subjects),
        predicate.unoccluded(subjects),
      ];
    case IntentKind.ShowOverview:
      return [predicate.elevationAtLeast(INTENT_DEFAULTS.overviewElevation), predicate.visible()];
    default:
      return [predicate.visible(subjects)];
  }
}

/** 求解时「种子位姿」的类型别名，让 SolveRequest 的意图更清楚。 */
export type SeedPose = Pose;
