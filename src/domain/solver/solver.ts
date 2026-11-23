/**
 * L3 领域层 · M8 第一版求解器：候选采样 + 约束打分
 *
 * 依据：《项目概要设计文档》§4.2.2、§6.2。
 *
 * 算法（一眼可读的穷举，刻意不做黑箱）：
 *   ① 生成候选位姿网格（sampling.ts）
 *   ② 对每个候选：先按意图推出配套的视觉效果，再逐条算谓词满足度并加权求和
 *   ③ 取最高分的候选
 *   ④ 用保真度模块复核，填好 conflicts 与 fidelity
 *
 * **为什么「先推特效再算谓词」这个顺序很重要**：`REDUCE_OCCLUSION` 的意图可以靠
 * 「调透明遮挡物」来满足，而透明化会**改变谓词的计算结果**（`unoccluded` 里把
 * 隐藏集合排除掉了）。如果先算谓词再补特效，就会出现「分数说满足、实际画面不满足」
 * 的假阳性。因此本求解器把特效当成候选的一部分，特效与位姿一起评估。
 */
import type {
  ConstraintConflict,
  FidelityInput,
  SceneSummary,
  SolveRequest,
  SolveResult,
  ViewSolver,
  VisualEffects,
} from '../types/solver.ts';
import { targetIds } from '../types/solver.ts';
import type { Pose, Vec3 } from '../types/geometry.ts';
import type { ComponentId } from '../types/component.ts';
import type { VisualIntent } from '../types/intent.ts';
import { IntentKind } from '../types/intent.ts';
import { evaluateFidelity } from '../fidelity/fidelity.ts';
import { computeContextIds } from './context.ts';
import { findOccluders, focusPoint, focusScale, sampleCandidates } from './sampling.ts';
import { canonicalizePose, clamp, v3distance } from '../../core/math.ts';

/** 判定「求解成功」的保真度门槛。低于它即便找到了最优候选也报 Failed（FR-19）。 */
export const SOLVE_ACCEPT_THRESHOLD = 0.65;

/**
 * 候选打分的先验权重。
 *
 * **为什么需要先验而不是直接取满足度之和**：纯满足度求和会让求解器偏好「极端的
 * 位姿」——例如把相机怼到构件表面，`screenCoverage` 直接爆表。这类解在数值上
 * 最优，但画面完全不能用（看不到整体形态）。因此加三条温和的先验：
 * 离目标太近扣分、太远扣分、视野角过大略扣。
 *
 * 这些先验都是**有界的小修正**，不会压过意图本身的约束——否则就成了
 * 「求解器在偷偷改意图」，那就违背了 §6.2 立场 1。
 */
export const PRIOR_WEIGHT = 0.15;

/** 先验评分：位姿本身是否「可用」（与意图无关的构图常识）。返回值在 [0,1]。 */
export function priorScore(pose: Pose, focus: Vec3, scale: number): number {
  const ratio = v3distance(pose.position, focus) / Math.max(scale, 0.1);
  let score = 1;
  if (ratio < 2.2) score -= clamp((2.2 - ratio) / 2.2, 0, 1) * 0.6;
  if (ratio > 8) score -= clamp((ratio - 8) / 12, 0, 1) * 0.5;
  if (pose.fovY > Math.PI / 3.6) score -= 0.15;
  return clamp(score, 0, 1);
}

/** 一个候选及其评估结果。 */
export interface ScoredCandidate {
  pose: Pose;
  effects: VisualEffects;
  /** 意图满足度（加权平均，未含先验） */
  intentScore: number;
  /** 含先验的综合分，用于排序 */
  score: number;
  fidelity: number;
  conflicts: ConstraintConflict[];
}

/**
 * 根据意图推导配套的视觉效果。
 *
 * **这是意图 → 特效的唯一映射处。** 五类意图各有各的默认特效，但都只影响
 * `VisualEffects` 这个纯数据对象，不触碰任何渲染状态——因此本函数可以在
 * Node 下单测。
 */
export function effectsForIntent(
  intent: VisualIntent,
  targetIdList: ComponentId[],
  pose: Pose,
  scene: SceneSummary,
  targetRef: SolveRequest['target'],
): VisualEffects {
  const effects: VisualEffects = {
    highlight: [...targetIdList],
    transparent: [],
    hidden: [],
  };

  switch (intent.kind) {
    case IntentKind.Emphasize:
      // 强调：目标高亮即可。遮挡交给相机位置去解决（采样会自然挑到看得见的角度）
      break;

    case IntentKind.ReduceOcclusion: {
      // 减少遮挡：把挡在视线上的构件调透明。**不隐藏**——隐藏会让场景失去参照，
      // 讲解时观众会不知道「原来这里有什么」。
      const occluders = findOccluders(targetRef, pose, scene);
      for (const id of occluders) effects.transparent.push({ id, opacity: 0.18 });
      break;
    }

    case IntentKind.KeepContext:
      // 保留上下文：目标高亮，其余保持原状（contextVisible 谓词会约束它们可见）
      break;

    case IntentKind.RevealRelation:
      // 揭示关系：两端都高亮。**两端高亮是必要的**——只亮一端，观众看不出关系。
      break;

    case IntentKind.ShowOverview:
      // 俯瞰：不高亮任何单个构件。全亮等于全不亮，反倒失去重点
      effects.highlight = [];
      break;
  }

  return effects;
}

/**
 * 候选评估：先推特效，再算谓词，最后加权。
 *
 * 把这一步抽成独立函数而不是塞进循环里，是为了让测试能直接对**单个候选**
 * 断言，而不用跑完整个网格——调试求解器时这是刚需。
 */
export function scoreCandidate(
  pose: Pose,
  request: SolveRequest,
  contextIds: ComponentId[],
): ScoredCandidate {
  const targetIdList = targetIds(request.target);
  const effects = effectsForIntent(request.intent, targetIdList, pose, request.scene, request.target);

  const input: FidelityInput = {
    intent: request.intent,
    target: request.target,
    pose,
    effects,
    scene: request.scene,
  };
  const { report } = evaluateFidelity(input, contextIds);

  const focus = focusPoint(request.target, request.scene);
  const scale = focusScale(request.target, request.scene);
  const prior = priorScore(pose, focus, scale);

  // 先验与意图分加权：意图分占大头（1 - PRIOR_WEIGHT），先验只做微微的偏置
  const score = report.overall * (1 - PRIOR_WEIGHT) + prior * PRIOR_WEIGHT;

  return {
    pose,
    effects,
    intentScore: report.overall,
    score,
    fidelity: report.overall,
    conflicts: report.conflicts,
  };
}

/**
 * 第一版求解器实现：候选采样 + 约束打分。
 *
 * **可复现性是它的核心卖点**（§6.2 立场 2）：给定相同的 `SolveRequest`，
 * 输出必然逐位相同——没有随机数、没有时间依赖、没有 Map 遍历顺序依赖
 * （`sampleCandidates` 用双层索引循环而非 Map.keys()）。
 */
export class SamplingSolver implements ViewSolver {
  readonly name = 'sampling-v1';

  solve(request: SolveRequest): SolveResult {
    const contextIds = computeContextIds(request.target, request.scene);
    const candidates = sampleCandidates(request);

    if (candidates.length === 0) {
      return {
        ok: false,
        camera: null,
        effects: { highlight: [], transparent: [], hidden: [] },
        fidelity: { overall: 0, perPredicate: [], conflicts: [] },
        conflicts: [
          {
            measure: 'visible',
            achieved: 0,
            required: '目标存在于场景中',
            note: '场景摘要为空或目标构件不在其中，无法生成任何候选视点',
          },
        ],
        solver: this.name,
        evaluated: 0,
      };
    }

    let best: ScoredCandidate | null = null;
    for (const pose of candidates) {
      const scored = scoreCandidate(pose, request, contextIds);
      // 严格「>」而非「>=」：保证同分时取**先出现的**候选，从而让输出
      // 只依赖候选生成顺序这个确定性的量（可复现性）
      if (best === null || scored.score > best.score) best = scored;
    }

    // best 不可能为 null（candidates 非空），但 TS 不知道，显式收窄
    const winner = best as ScoredCandidate;

    // ★ 输出前把 -0 规范成 0：向量运算（叉积）会产出 -0，而 JSON.stringify(-0) 是 0，
    //   因此不规范化的话「存盘再读回来」的位姿与内存里的不严格相等（详见 canonicalizePose）。
    const winnerPose = canonicalizePose(winner.pose);
    const ok = winner.fidelity >= SOLVE_ACCEPT_THRESHOLD;

    // ★ FR-19：不管成败都如实汇报冲突清单，**绝不用「尽力而为 + 沉默」代替**
    const conflicts = ok ? [] : winner.conflicts;

    return {
      ok,
      // 失败时**不写入相机**：写进去就等于「静默产出劣质结果」，
      // 上层无法分辨「这是好结果」还是「这是凑合的结果」
      camera: ok ? winnerPose : null,
      effects: winner.effects,
      fidelity: {
        overall: winner.fidelity,
        perPredicate: [],
        conflicts,
      },
      conflicts,
      solver: this.name,
      evaluated: candidates.length,
    };
  }
}

/**
 * 候选构成的「可选池」——把全部候选按分数排序返回。
 *
 * 用途有两个：
 *  - UI 上的「换一个角度」候选列表（FR-19 提到要给出替代方案）；
 *  - 论文里分析「最优解与次优解差多少」，判断意图是否本身难以满足。
 */
export function rankCandidates(request: SolveRequest, limit = 10): ScoredCandidate[] {
  const contextIds = computeContextIds(request.target, request.scene);
  return sampleCandidates(request)
    .map((pose) => scoreCandidate(pose, request, contextIds))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** 供 UI 展示：求解结果的一句话描述。 */
export function describeSolveResult(result: SolveResult): string {
  if (result.ok) {
    return `已由「${result.solver}」求解，保真度 ${Math.round(result.fidelity.overall * 100)}%（考察 ${result.evaluated} 个候选）`;
  }
  return `求解失败：${result.conflicts.length} 条约束无法满足（考察 ${result.evaluated} 个候选）`;
}

/** 目标构件中心的便捷取用（求解与保真度都用得上）。 */
export function targetCenter(request: SolveRequest): Vec3 {
  return focusPoint(request.target, request.scene);
}
