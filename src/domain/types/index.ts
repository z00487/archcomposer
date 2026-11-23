/**
 * 领域类型总出口（《项目概要设计文档》§7.2 硬规定 2：「`domain/types/` 是唯一的类型真源」）
 *
 * **为什么要有一个 index**：任务二 §7.2 说「其它层不得各自定义重复类型」。
 * 一个统一的出口让上层只需要 `import ... from '../domain/types/index.ts'`，
 * 而不必记住某个类型在 component.ts 还是 solver.ts 里——更重要的是，
 * 将来拆分或合并文件时，上层的 import 一行都不用改。
 *
 * ⚠️ 本文件**只做 re-export**，不定义任何自己的东西。定义散落各处会让
 * 「唯一真源」这条规定名存实亡。
 */
export type { Vec3, Quat, Aabb, Pose } from './geometry.ts';
export { clonePose, poseDistance } from './geometry.ts';

export type { ComponentId, ComponentSemantics, ComponentRef } from './component.ts';

export {
  ComponentKind,
  KIND_LABELS,
  REPLACEABLE_KINDS,
  SIDE,
  EAVE,
  CORNER,
  PURLIN_LAYERS,
} from './vocabulary.ts';

export type {
  IntentKind as IntentKindType,
  IntentPredicate,
  IntentProvenance,
  IntentSignal,
  IntentPrediction,
  VisualIntent,
  MeasureName,
  PredicateValue,
} from './intent.ts';
export {
  IntentKind,
  IntentSource,
  INTENT_LABELS,
  INTENT_DESCRIPTIONS,
  INTENT_DEFAULTS,
  MEASURE_LABELS,
  predicate,
  defaultPredicatesFor,
  describePredicate,
  relationDistanceRange,
} from './intent.ts';

export type {
  TargetRef,
  SingleTarget,
  RelationTarget,
  RelationKind,
  VisualEffects,
  TransparentEntry,
  SceneComponent,
  SceneSummary,
  SolveRequest,
  SolveResult,
  ConstraintConflict,
  FidelityReport,
  ViewSolver,
  PredicateEvaluation,
  FidelityInput,
  FidelityEvaluation,
} from './solver.ts';
export {
  RelationKind as RelationKindConst,
  RELATION_LABELS,
  EMPTY_EFFECTS,
  cloneEffects,
  targetIds,
  describeTarget,
  sceneComponentAabb,
  findSceneComponent,
} from './solver.ts';

export type {
  SolveState as SolveStateType,
  StoryboardStep,
  Storyboard,
  StoryboardMeta,
  StoryboardModelRef,
  DemoAction,
  DemoRecord,
  DemoOutcome,
  PredictionBundle,
  TransitionKind,
} from './storyboard.ts';
export {
  SolveState,
  SOLVE_STATE_LABELS,
  TRANSITION_LABELS,
  DEFAULT_STEP_DURATION_MS,
  createStep,
  createStoryboard,
} from './storyboard.ts';
