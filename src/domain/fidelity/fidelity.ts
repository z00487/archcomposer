/**
 * L3 领域层 · M9 意图保真度与冲突检测
 *
 * 依据：《项目概要设计文档》§4.2.3、§6.2 的步骤 ⑤。
 *
 * **度量的是什么**：不是「画面好不好看」，而是**「换目标之后，原意图的约束还在不在」**。
 * 这是与 CinemaTraj 类工作的根本区别所在，也是任务一 §7.1 的 E1 评估的核心度量。
 *
 * **为什么把它独立成一个模块**（概要设计 §4.2.3 的论证）：因为它是**论文的可测量
 * 结论**。做成纯函数（输入位姿 + 意图 + 场景摘要，输出分数）之后，E1 就可以脱离
 * 浏览器批量跑——这是约束 C-1 最直接的收益。
 */
import type {
  ConstraintConflict,
  FidelityEvaluation,
  FidelityInput,
  FidelityReport,
  PredicateEvaluation,
  VisualEffects,
  SceneSummary,
} from '../types/solver.ts';
import type { Pose } from '../types/geometry.ts';
import type { ComponentId } from '../types/component.ts';
import type { VisualIntent } from '../types/intent.ts';
import { evaluatePredicates } from '../intent/predicates.ts';
import { clamp } from '../../core/math.ts';

/** 保真度低于此值时，即便求解器 `ok`，也应判为 `Failed`（概要设计 §6.2 步骤 ⑥）。 */
export const FIDELITY_ACCEPT_THRESHOLD = 0.65;

/**
 * 满足度 → 保真度分数的映射曲线。
 *
 * **为什么要这条曲线而不是直接用满足度**：因为「差一点点」和「差很多」在观感上
 * 不是线性的。占比要求 12%、实际 11% 时人眼几乎看不出区别，但按线性只有 0.92；
 * 而实际 3% 时已经是「根本看不见」。用一条先平后陡的曲线能让保真度更贴近
 * 「作者是否会接受这个结果」。
 *
 * 曲线取 `s^0.5` 再夹紧：满足度 0.5 → 0.71，满足度 0.9 → 0.95。
 * 这条曲线是**可调的、有意的**，不是随手写的常数——它决定了「多差才算失败」。
 */
function curve(score: number): number {
  return clamp(Math.sqrt(clamp(score, 0, 1)), 0, 1);
}

/**
 * 最差约束的惩罚系数。
 *
 * **为什么必须有这一项（这是概要设计 §4.2.3 第 3 条的落地）**：
 *
 * §4.2.3 第 3 条明确要求「当若干约束不可能同时满足时，**报告残差而不是强行加权
 * 抹平**」。但最初的实现是纯加权平均——那就正是「强行抹平」。实测抓到了它的后果：
 *
 *   一条**物理上不可能满足**的约束（要求画面占比 ≥ 3.0），实测满足度只有 0.163；
 *   经 `curve` 提升后为 0.404。它与另一条轻松满足的约束（无遮挡 = 1.0）等权平均，
 *   总体保真度 = 0.70 —— **越过了 0.65 的接受阈值，被判定为「求解成功」**。
 *
 * 也就是说：**只要意图里有一条无法满足的约束，它就能被其它约束的高分抬过去。**
 * 这与 FR-19「不许静默产出劣质结果」、与本文 §6.2 立场 3 直接冲突。
 *
 * 修法是在加权平均之上再减去「最差约束的缺口」的一半：
 *
 *   总体 = 加权平均 − PENALTY × (1 − 最差约束的满足度)
 *
 * 这样一条彻底失败的约束会把总体拉下来（上面的例子：0.70 − 0.5×0.596 = 0.40，
 * 正确判为不通过），而「差一点点」（最差 0.95）只扣 0.025，不会误伤。
 *
 * 系数取 0.5 而不是 1.0：保留一部分「这条约束偏弱、但其它约束很好」的可接受空间
 * ——**完全不接受任何一条不满足**会过于严苛，反而让作者放弃使用重定向功能。
 */
export const WORST_CONSTRAINT_PENALTY = 0.5;

/** 加权汇总逐条评估 → 总体保真度。 */
export function aggregate(evaluations: PredicateEvaluation[]): FidelityReport {
  if (evaluations.length === 0) {
    return { overall: 1, perPredicate: [], conflicts: [] };
  }

  let weighted = 0;
  let totalWeight = 0;
  let worst = 1;
  const perPredicate: FidelityReport['perPredicate'] = [];
  const conflicts: ConstraintConflict[] = [];

  for (const e of evaluations) {
    const w = e.predicate.weight > 0 ? e.predicate.weight : 1;
    const curved = curve(e.score);
    weighted += curved * w;
    totalWeight += w;
    if (curved < worst) worst = curved;
    perPredicate.push({ measure: e.predicate.measure, score: curved, weight: w });
    if (!e.satisfied) conflicts.push(toConflict(e));
  }

  const mean = totalWeight > 0 ? weighted / totalWeight : 1;
  // ★ 最差约束惩罚：不让一条彻底失败的约束被其它约束的高分抹平（§4.2.3 第 3 条）
  const overall = clamp(mean - WORST_CONSTRAINT_PENALTY * (1 - worst), 0, 1);

  return { overall, perPredicate, conflicts };
}

function toConflict(e: PredicateEvaluation): ConstraintConflict {
  return {
    measure: e.predicate.measure,
    achieved: e.measured,
    required: e.required,
    note: conflictNote(e),
  };
}

/**
 * 把「哪个约束没过」翻译成人能看懂的一句话。
 *
 * 这一段**必须写好**，因为 FR-19 要求「失败时明确告知，而不是静默产出劣质结果」，
 * 而告知的载体就是这句 note。UI 上直接展示它。
 */
function conflictNote(e: PredicateEvaluation): string {
  const { measure, required, measured } = {
    measure: e.predicate.measure,
    required: e.required,
    measured: e.measured,
  };
  switch (measure) {
    case 'screenCoverage':
      return measured < 0.01
        ? '目标几乎不在画面内或完全被遮挡，无法形成有效构图'
        : `目标在画面中偏小（实测 ${pct(measured)}，要求 ${required}），建议把相机拉近或改换观察角度`;
    case 'unoccluded':
      return measured === 0
        ? '目标被其它构件完全挡住；可考虑隐藏遮挡物、调整角度或调高相机'
        : `目标被部分遮挡（可见 ${pct(measured)}）；可考虑降低遮挡物透明度或绕到另一侧`;
    case 'visible':
      return '目标当前不在相机视野内';
    case 'coVisible':
      return '两个目标构件无法同时入画，可能距离过远或分处模型两端；建议放宽构图或改用单目标讲解';
    case 'screenDistance':
      return measured < Number.parseFloat(e.required.replace(/[^\d.]/g, ''))
        ? '两个构件在画面中靠得太近，搭接/承托关系不易辨认；建议拉近视角或错开观察方向'
        : '两个构件在画面中分得太开，同框时各自都太小；建议拉远一点让二者同时清晰';
    case 'elevationRatio':
      return '相机俯角不足，无法形成俯瞰构图；建议把相机升高或把视点调低';
    case 'contextVisible':
      return '部分上下文构件不在画面内，结构关系失去参照；建议后退一点把周边结构纳入';
    default:
      return `约束 ${measure} 未满足（实测 ${trim(measured)}，要求 ${required}）`;
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

/**
 * 评估一个位姿对某条意图的满足程度。
 *
 * `contextIds` 是「上下文构件」的集合，只有 `KEEP_CONTEXT` 类意图需要它。
 * **刻意做成参数而不是从 scene 里猜**：上下文是业务含义（哪些构件算「周边结构」），
 * 让领域层自己猜会把业务规则藏进几何计算里。
 */
export function evaluateFidelity(
  input: FidelityInput,
  contextIds: ComponentId[] = [],
): FidelityEvaluation {
  const evaluations = evaluatePredicates(input, contextIds);
  return { report: aggregate(evaluations), evaluations };
}

/**
 * 重定向保真度（概要设计 §4.2.3 的第 2 条）。
 *
 * **定义**：「重定向前后该步骤各约束满足度的一致性」。
 *
 * 直观解释：如果重定向前的步骤「本来就很好地表达了意图」，重定向后也应该同样好。
 * 因此这里算的不是「新位姿有多好」，而是**「新旧位姿在表达同一意图上有多接近」**。
 *
 * 两者的区别很重要：
 *  - 只用新位姿的分数 → 无法区分「换目标本来就不合适」与「求解器没解好」；
 *  - 用一致性 → 若旧位姿本身就差（分低），新位姿同样差时不扣分，判定更公道。
 *
 * 返回的 `overall` 取「新旧分数的较小者再按一致性打折」：任何一个环节差，
 * 保真度都会低——这是有意的保守，宁可让作者复核，也不要给一个虚高的分数。
 */
export function evaluateRedirectionFidelity(
  before: { pose: Pose; effects: VisualEffects; target: FidelityInput['target'] },
  after: { pose: Pose; effects: VisualEffects; target: FidelityInput['target'] },
  intent: VisualIntent,
  scene: SceneSummary,
  contextIds: ComponentId[] = [],
): {
  before: FidelityEvaluation;
  after: FidelityEvaluation;
  consistency: number;
  overall: number;
} {
  const beforeEval = evaluateFidelity(
    { intent, target: before.target, pose: before.pose, effects: before.effects, scene },
    contextIds,
  );
  const afterEval = evaluateFidelity(
    { intent, target: after.target, pose: after.pose, effects: after.effects, scene },
    contextIds,
  );

  // 逐谓词比较满足度，取平均一致性
  const n = Math.min(beforeEval.evaluations.length, afterEval.evaluations.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const a = curve(beforeEval.evaluations[i].score);
    const b = curve(afterEval.evaluations[i].score);
    sum += 1 - Math.abs(a - b);
  }
  const consistency = n > 0 ? clamp(sum / n, 0, 1) : 1;
  const overall = clamp(Math.min(beforeEval.report.overall, afterEval.report.overall) * consistency, 0, 1);

  return { before: beforeEval, after: afterEval, consistency, overall };
}

/**
 * 从评估结果提炼「替代方案」建议（FR-19 要求失败时给出可操作的建议）。
 *
 * 规则化、保守：只在能确定因果时才给建议，否则返回空数组让 UI 只显示冲突。
 * **不给「万能建议」**——那会让用户不再相信建议。
 */
export function suggestRemedies(
  report: FidelityReport,
  scene: SceneSummary,
  intent: VisualIntent,
): string[] {
  const out: string[] = [];
  const measures = new Set(report.conflicts.map((c) => c.measure));

  if (measures.has('unoccluded') || measures.has('screenCoverage')) {
    const occluders = scene.components.filter((c) => c.visible && c.replaceable);
    if (occluders.length > 0) {
      out.push('把挡住目标的构件调成半透明或暂时隐藏，可在特效面板一键完成');
    }
    out.push('换到目标另一侧的观察角度，避开遮挡物');
    out.push('适当升高相机，从上方越过遮挡物观察');
  }
  if (measures.has('coVisible') || measures.has('screenDistance')) {
    out.push('把相机拉远并调整朝向，让两个构件同时入画；若仍不行，说明二者在模型中相距过远');
    out.push('拆成两个步骤分别讲解两端构件，再用旁白说明它们的关系');
  }
  if (measures.has('elevationRatio')) {
    out.push('升高相机位置以获得更俯视的构图');
  }
  if (measures.has('contextVisible')) {
    out.push('稍微后退，把周边结构一并纳入画面');
  }

  // 若意图是「揭示关系」但目标本身不是关系型，指出这是结构性问题
  if (intent.kind === 'REVEAL_RELATION' && measures.has('coVisible')) {
    out.push('当前意图要求「关系」，但目标只指定了单个构件；可先把目标改为「构件 A 与构件 B」再重解');
  }

  return out;
}

/** 便于 UI 展示的一句话总结。 */
export function describeFidelity(report: FidelityReport): string {
  const score = Math.round(report.overall * 100);
  if (report.conflicts.length === 0) return `意图保真度 ${score}%，全部约束满足`;
  return `意图保真度 ${score}%，有 ${report.conflicts.length} 条约束未满足`;
}

/** 目标 ID 列表的便捷转发，供调用方少 import 一个模块。 */
