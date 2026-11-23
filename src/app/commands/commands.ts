/**
 * L4 应用层 · M11 用例编排（含 `redirectStep`）
 *
 * 依据：《项目概要设计文档》§4.1 的 M11、§6.2 的七步流程、§6.1 的确认流程。
 *
 * **本文件是「整篇论文的技术心脏」在代码里的落点。** 它不做算法，算法在 L3；
 * 它做的是**编排**——按正确的顺序调用 L3 与 L2，并在每一步之后维护好数据状态。
 *
 * **一条纪律：命令是唯一的写入口。** UI 想改数据，必须调这里的函数，不能自己
 * 拼一个对象塞进 Store。这样「改目标必标 stale」「求解失败不写劣质结果」这类
 * 不变量才有地方保证。
 */
import type { AppStores } from '../stores/stores.ts';
import type { SolverRegistry } from '../../domain/solver/registry.ts';
import type { EffectManager } from '../../runtime/effects/effects.ts';
import type { ComponentId, ComponentSemantics } from '../../domain/types/component.ts';
import type {
  PredictionBundle,
  StoryboardStep,
  Storyboard,
  DemoOutcome,
} from '../../domain/types/storyboard.ts';
import { createStep } from '../../domain/types/storyboard.ts';
import type {
  SolveRequest,
  TargetRef,
  VisualEffects,
} from '../../domain/types/solver.ts';
import { describeTarget, targetIds } from '../../domain/types/solver.ts';
import type { VisualIntent, IntentPrediction } from '../../domain/types/intent.ts';
import { INTENT_LABELS, defaultPredicatesFor } from '../../domain/types/intent.ts';
import type { Pose } from '../../domain/types/geometry.ts';
import type { CameraMotion } from '../../domain/types/motion.ts';
import { describeMotion, orbitMotion } from '../../domain/types/motion.ts';
import { EditCommandKind } from '../../domain/language/instructions.ts';
import type { EditCommand } from '../../domain/language/instructions.ts';
import type { FeedbackDiagnosis } from '../../domain/language/feedback.ts';
import { makeId } from '../../core/id.ts';
import {
  addStep,
  applySolveResult,
  duplicateStep as duplicateStepIn,
  findStep,
  markStale,
  moveStep as moveStepIn,
  removeStep,
  describeStep,
  retargetStep,
  checkKindChange,
  updateIntent,
  updateStep,
  validateStoryboard,
  checkModelCompatibility,
} from '../../domain/storyboard/storyboard.ts';
import { evaluateRedirectionFidelity, describeFidelity, FIDELITY_ACCEPT_THRESHOLD } from '../../domain/fidelity/fidelity.ts';
import { computeContextIds } from '../../domain/solver/context.ts';
import { isSameKind, rankReplacementCandidates } from '../../domain/naming/naming.ts';

/** 命令层需要的宿主能力。全部由 main.ts 在装配阶段注入，便于测试替换。 */
export interface CommandContext {
  stores: AppStores;
  registry: SolverRegistry;
  effects: EffectManager;
  /** 按 ID 解析构件引用（L2 提供）。返回 null 表示该 ID 不在当前模型里。 */
  refOf(id: ComponentId): { id: ComponentId; semantics: ComponentSemantics } | null;
  /** 按 ID 取人类可读名（L2 提供） */
  labelOf(id: ComponentId): string;
  /** 把求解出的机位应用到视口（L2 提供） */
  applyCamera(pose: Pose): void;
  /** 把 OrbitControls 的目标点移到某个构件（L2 提供） */
  focusOn(id: ComponentId): void;
  /** 轻提示 */
  toast(message: string): void;
}

// ── 查询辅助 ───────────────────────────────────────────────────

export function currentStoryboard(ctx: CommandContext): Storyboard {
  return ctx.stores.storyboard.get().storyboard;
}

/** 用当前模型中的构件构造一个单目标引用。 */
export function singleTarget(ctx: CommandContext, id: ComponentId): TargetRef | null {
  const ref = ctx.refOf(id);
  return ref ? { form: 'single', component: ref } : null;
}

/** 所有步骤的说明文本（UI 列表用）。 */
export function stepSummaries(ctx: CommandContext): Array<{ step: StoryboardStep; subtitle: string }> {
  const sb = currentStoryboard(ctx);
  return sb.steps.map((step) => ({
    step,
    subtitle: describeStep(step, (id) => ctx.labelOf(id)),
  }));
}

// ── 步骤的增删改（FR-8）────────────────────────────────────────

/**
 * 从「当前选中的构件」新建一个步骤。
 *
 * 新步骤的 `solve` 是 `'none'`、`camera` 是 `null`——这是**有意的**：
 * 还没定机位的步骤应当显示为「未求解」，而不是「求解失败」（§6.3 的播放提示
 * 对这两种状态的处理完全不同）。
 */
export function addStepFromSelection(ctx: CommandContext, intent?: VisualIntent | null): string | null {
  const selected = ctx.stores.selection.get().selectedId;
  if (!selected) {
    ctx.toast('请先在场景中选择一个构件');
    return null;
  }
  const target = singleTarget(ctx, selected);
  if (!target) {
    ctx.toast('选中的构件不在当前模型中');
    return null;
  }

  const step = createStep(target, `讲解 ${ctx.labelOf(selected)}`);
  const withIntent = intent
    ? { ...step, intent, solve: 'stale' as const, solveNote: '意图已确定，等待求解机位' }
    : step;

  const sb = currentStoryboard(ctx);
  const next = addStep(sb, withIntent);
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next, activeStepId: withIntent.id }));
  ctx.toast(`已新建步骤：${withIntent.title}`);
  return withIntent.id;
}

export function deleteStep(ctx: CommandContext, stepId: string): void {
  const sb = currentStoryboard(ctx);
  const next = removeStep(sb, stepId);
  const active = ctx.stores.storyboard.get().activeStepId;
  ctx.stores.storyboard.set((s) => ({
    ...s,
    storyboard: next,
    activeStepId: active === stepId ? (next.steps[0]?.id ?? null) : active,
  }));
}

export function duplicateStep(ctx: CommandContext, stepId: string): void {
  const sb = currentStoryboard(ctx);
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: duplicateStepIn(sb, stepId) }));
  ctx.toast('已复制步骤');
}

export function moveStep(ctx: CommandContext, from: number, to: number): void {
  const sb = currentStoryboard(ctx);
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: moveStepIn(sb, from, to) }));
}

/** 仅更新标题/旁白这类不触发重算的字段。 */
export function updateStepText(
  ctx: CommandContext,
  stepId: string,
  patch: { title?: string; narration?: string; durationMs?: number; transition?: StoryboardStep['transition'] },
): void {
  const sb = currentStoryboard(ctx);
  const steps = sb.steps.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: { ...sb, steps } }));
}

export function setActiveStep(ctx: CommandContext, stepId: string | null): void {
  ctx.stores.storyboard.set((s) => ({ ...s, activeStepId: stepId }));
}

// ── 运镜（开题报告 §3.5、PPT 第 9 页的「全景环绕 · 360°」）────

/**
 * 设置或清除某一步的运镜。
 *
 * **为什么它不改 `solve`**：运镜是叠加在 `camera` 之上的相对运动，不改变
 * 「这一步的目标与意图是否已被满足」这个判断。因此设了运镜不需要重解，
 * `solve` 状态原封不动——如果把它标成 stale，用户会看到「待重算」却怎么
 * 重算都还是 stale（因为求解器不管运镜），那是误导。
 */
export function setStepMotion(ctx: CommandContext, stepId: string, motion: CameraMotion | null): void {
  const sb = currentStoryboard(ctx);
  const step = findStep(sb, stepId);
  if (!step) return;

  if (motion && !step.camera) {
    ctx.toast('这一步还没有机位，请先求解或预览一次，再设置运镜');
    return;
  }

  const next = updateStep(sb, stepId, (s) => ({ ...s, motion }));
  ctx.stores.storyboard.set((state) => ({ ...state, storyboard: next }));
  ctx.toast(motion ? `已设置运镜：${describeMotion(motion)}` : '已清除这一步的运镜');
}

// ── 求解 ───────────────────────────────────────────────────────

/** 用当前场景与相机状态构造一个 SolveRequest（§6.2 步骤 ③）。 */
export function buildSolveRequest(
  ctx: CommandContext,
  step: StoryboardStep,
  intent: VisualIntent,
  seedOverride?: Pose | null,
): SolveRequest | null {
  const scene = ctx.stores.scene.get().summary;
  if (!scene) {
    ctx.toast('场景尚未就绪，无法求解');
    return null;
  }
  return {
    target: step.target,
    intent,
    scene,
    // 种子取「步骤里已有的旧机位」，其次取当前视口位姿——两者都比随机初值好
    seed: seedOverride ?? step.camera ?? ctx.stores.camera.get().pose ?? null,
    maxCandidates: 640,
  };
}

/**
 * 对单个步骤求解（不换目标）。
 *
 * 用于「新建步骤后点『求解机位』」以及「失败后重试」。
 */
export function solveStep(ctx: CommandContext, stepId: string): boolean {
  const sb = currentStoryboard(ctx);
  const step = findStep(sb, stepId);
  if (!step) return false;
  const intent = step.intent;
  if (!intent) {
    ctx.toast('该步骤还没有意图，请先确定意图');
    return false;
  }

  const request = buildSolveRequest(ctx, step, intent);
  if (!request) return false;

  const result = ctx.registry.solve(request);
  const note = result.ok
    ? `已求解，${describeFidelity(result.fidelity)}`
    : `求解失败：${result.conflicts.map((c) => c.note ?? c.measure).join('；')}`;

  const next = applySolveResult(sb, stepId, {
    camera: result.camera,
    effects: result.effects,
    note,
    ok: result.ok,
  });
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next }));

  // 成功时把相机与特效都应用到视口，作者能立刻看到结果
  if (result.ok && result.camera) {
    ctx.applyCamera(result.camera);
    ctx.focusOn(targetIds(step.target)[0]);
    ctx.effects.apply(result.effects);
    ctx.toast(note);
  } else {
    // ★ FR-19：失败时**不改变视口**，只把冲突清单呈现出来
    ctx.toast(note);
  }
  return result.ok;
}

// ── ★ 意图保持重定向（FR-16 ~ FR-19，§6.2）────────────────────

/**
 * 换目标并重解。**这是整篇论文的核心流程。**
 *
 * 严格按 §6.2 的七步执行，每一步都在下面注明。注意三个不可动摇的立场：
 *
 *  1. **意图在重定向中不变**（立场 1）——本函数只读 `step.intent`，绝不修改它；
 *  2. **候选采样**（立场 2）——由 `registry` 里的实现决定，本层不关心；
 *  3. **失败要显式暴露**（立场 3）——`ok` 为假时**不写入任何劣质结果**，
 *     而是把步骤标成 `'failed'` 并把冲突清单交给 UI。
 *
 * **非同类构件的处理**（§6.2 步骤 ⑦）：允许操作，但在返回值里带上警告，
 * 让 UI 必须让用户确认。为什么允许？因为「用强调斗拱的构图去拍屋顶」虽然
 * 多半无意义，但**也可能正是作者想要的**——系统不该替作者否决，只该提醒。
 */
export function redirectStep(
  ctx: CommandContext,
  stepId: string,
  newTarget: TargetRef,
): { ok: boolean; fidelity: number; warnings: string[]; conflicts: string[] } {
  const sb = currentStoryboard(ctx);
  const step = findStep(sb, stepId);
  if (!step) return { ok: false, fidelity: 0, warnings: ['找不到该步骤'], conflicts: [] };

  const scene = ctx.stores.scene.get().summary;
  if (!scene) return { ok: false, fidelity: 0, warnings: ['场景尚未就绪'], conflicts: [] };

  const warnings: string[] = [];

  // ⑦ 先做「是否同类」的检查（放在最前，因为警告要随结果一起返回）。
  //    判定规则本身在领域层（checkKindChange），命令层只负责把它塞进返回值。
  const kindWarning = checkKindChange(step.target, newTarget);
  if (kindWarning) warnings.push(kindWarning);

  // ①② 更新 target，意图原封不动，并立刻把状态标成 'stale'
  let next = retargetStep(sb, stepId, newTarget);
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next }));

  // 标记后立即把状态推给 UI（这一步是「数据层立即反映实现已失效」的体现）
  ctx.toast('目标已更换，正在按原意图重新求解…');

  const updated = findStep(next, stepId)!;
  const intent = updated.intent;

  // 没有意图的步骤：只能标 stale，无法重解——如实告知，不假装成功
  if (!intent) {
    return {
      ok: false,
      fidelity: 0,
      warnings: [...warnings, '该步骤还没有意图，无法按意图重解；请先为它确定一个意图'],
      conflicts: [],
    };
  }

  // ③ 构造 SolveRequest（seed 用旧机位）
  const request = buildSolveRequest(ctx, updated, intent, updated.camera);
  if (!request) return { ok: false, fidelity: 0, warnings, conflicts: [] };

  // ④ 求解
  const result = ctx.registry.solve(request);

  // ⑤ 保真度：比较重定向前后的约束满足度（§4.2.3 的第 2 条）
  const contextIds = computeContextIds(updated.target, scene);
  let fidelityOverall = result.fidelity.overall;
  if (step.camera && result.camera) {
    const redirection = evaluateRedirectionFidelity(
      { pose: step.camera, effects: step.effects, target: step.target },
      { pose: result.camera, effects: result.effects, target: updated.target },
      intent,
      scene,
      contextIds,
    );
    fidelityOverall = redirection.overall;
  }

  // ⑥ 判定：ok 且保真度达标才写入
  const accepted = result.ok && result.camera !== null && fidelityOverall >= FIDELITY_ACCEPT_THRESHOLD;

  if (accepted) {
    const note = `已按原意图重解，保真度 ${Math.round(fidelityOverall * 100)}%`;
    next = applySolveResult(next, stepId, {
      camera: result.camera,
      effects: result.effects,
      note,
      ok: true,
    });
    ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next }));
    ctx.applyCamera(result.camera!);
    ctx.focusOn(targetIds(newTarget)[0]);
    ctx.effects.apply(result.effects);
    ctx.toast(note);
    return { ok: true, fidelity: fidelityOverall, warnings, conflicts: [] };
  }

  // ★ 失败路径：不写入劣质结果（立场 3）
  const conflictNotes = result.conflicts.map((c) => c.note ?? `${c.measure} 未满足（实测 ${c.achieved}，要求 ${c.required}）`);
  const failNote = result.ok
    ? `重解结果保真度仅 ${Math.round(fidelityOverall * 100)}%，低于接受阈值 ${Math.round(FIDELITY_ACCEPT_THRESHOLD * 100)}%——已保留原状态，未写入该结果`
    : `重解失败：${conflictNotes.length} 条约束无法同时满足`;

  next = applySolveResult(next, stepId, { camera: null, effects: result.effects, note: failNote, ok: false });
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next }));
  ctx.toast(failNote);
  return { ok: false, fidelity: fidelityOverall, warnings, conflicts: conflictNotes.length > 0 ? conflictNotes : [failNote] };
}

/**
 * 换同类构件（FR-16 的典型用法）。
 *
 * 与 `redirectStep` 的区别：它**自己找候选**，只接受同类构件的 ID。
 * 候选排序用 L3 的 `rankReplacementCandidates`（文档三 §7.3）。
 */
export function replaceWithSameKind(ctx: CommandContext, stepId: string, candidateId?: ComponentId): ReturnType<typeof redirectStep> {
  const sb = currentStoryboard(ctx);
  const step = findStep(sb, stepId);
  if (!step) return { ok: false, fidelity: 0, warnings: ['找不到该步骤'], conflicts: [] };
  if (step.target.form !== 'single') {
    return { ok: false, fidelity: 0, warnings: ['关系型目标暂不支持一键换同类构件，请分别指定两端'], conflicts: [] };
  }

  const scene = ctx.stores.scene.get().summary;
  if (!scene) return { ok: false, fidelity: 0, warnings: ['场景尚未就绪'], conflicts: [] };

  if (candidateId) {
    const ref = ctx.refOf(candidateId);
    if (!ref) return { ok: false, fidelity: 0, warnings: ['候选构件不在当前模型中'], conflicts: [] };
    return redirectStep(ctx, stepId, { form: 'single', component: ref });
  }

  // 没给候选就自己挑：按同类判定 + 排序规则取第一个
  const candidates = candidateCandidates(ctx, stepId);
  if (candidates.length === 0) {
    return { ok: false, fidelity: 0, warnings: ['没有找到可替换的同类构件'], conflicts: [] };
  }
  const picked = candidates[0];
  const ref = ctx.refOf(picked)!;
  return redirectStep(ctx, stepId, { form: 'single', component: ref });
}

/** 列出某步骤可替换的同类构件（UI 的候选列表用）。 */
export function candidateCandidates(ctx: CommandContext, stepId: string): ComponentId[] {
  const sb = currentStoryboard(ctx);
  const step = findStep(sb, stepId);
  const scene = ctx.stores.scene.get().summary;
  if (!step || !scene || step.target.form !== 'single') return [];

  const current = step.target.component;
  // 先按「同类判定」（§7.3：kind 相等即同类）过滤，再按排序规则推荐。
  // 两步不能合并：排序函数假定输入已经是同类候选，它只负责排先后。
  const pool = scene.components
    // ★ 必须排除当前目标自身。否则「换同类构件」会挑到它自己——
    //   那是一次空操作，用户点了按钮却什么都没变，会以为功能坏了。
    //   这个漏洞是写命令层测试时被断言抓出来的（测试里候选集合多了自身）。
    .filter((c) => c.id !== current.id && c.visible && isSameKind(current.semantics, c.semantics))
    .map((c) => ({ id: c.id, semantics: c.semantics }));

  return rankReplacementCandidates(current.semantics, pool).map((c) => c.id);
}

// ── 意图确认（FR-14 / §6.1）────────────────────────────────────

/**
 * 接受一个候选意图。
 *
 * **这是意图进入系统的唯一入口之一**（另一个是用户手动选择）。因此这里必须把
 * `provenance.confirmedByUser` 置为 true——FR-14 要求「人工确认」，而确认这件事
 * 需要留痕：论文里要区分「系统推断的」与「用户确认的」。
 */
export function acceptPrediction(
  ctx: CommandContext,
  prediction: IntentPrediction,
  applyToStepId?: string,
): void {
  const confirmed: VisualIntent = {
    ...prediction.intent,
    id: prediction.intent.id || makeId('intent'),
    provenance: { ...prediction.intent.provenance, confirmedByUser: true },
  };

  if (applyToStepId) {
    const sb = currentStoryboard(ctx);
    const next = updateIntent(sb, applyToStepId, confirmed);
    ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next }));
    ctx.toast(`已应用意图「${INTENT_LABELS[confirmed.kind]}」，请点「按意图求解」`);
    return;
  }

  // 没有指定步骤：直接用当前选中构件新建一个步骤
  addStepFromSelection(ctx, confirmed);
}

/**
 * 用户从意图类型表手动选择（§6.1 的失败处理）。
 *
 * **为什么必须有这条路径**：「不猜」是 FR-14 的精神。当规则匹配不出任何候选时，
 * 系统应该让用户自己说，而不是给一个低置信度的瞎猜。这条路径也顺带说明了一件事：
 * 系统的推断能力**不是必需的**——即便推断完全失败，整套重定向机制仍然可用。
 */
export function setManualIntent(ctx: CommandContext, stepId: string, kind: VisualIntent['kind']): void {
  const sb = currentStoryboard(ctx);
  const step = findStep(sb, stepId);
  if (!step) return;

  const subjects = targetIds(step.target);
  const intent: VisualIntent = {
    id: makeId('intent'),
    kind,
    predicates: defaultPredicatesFor(kind, subjects.length > 1 ? subjects : []),
    provenance: {
      source: 'manual',
      confidence: 1,
      rationale: `由用户手动指定为「${INTENT_LABELS[kind]}」`,
      confirmedByUser: true,
    },
  };
  const next = updateIntent(sb, stepId, intent);
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next }));
  ctx.toast(`已设置意图「${INTENT_LABELS[kind]}」`);
}

/** 清除某步骤的意图（回到「未指定」）。 */
export function clearIntent(ctx: CommandContext, stepId: string): void {
  const sb = currentStoryboard(ctx);
  const next = updateStep(sb, stepId, (step) => ({
    ...step,
    intent: null,
    solve: markStale(step.solve),
    solveNote: '意图已清除',
  }));
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next }));
}

// ── 示范录制（FR-11 ~ FR-13）───────────────────────────────────

/**
 * 结束示范并把候选意图放进 Store，等 UI 弹确认框。
 *
 * 归约逻辑（actions → DemoOutcome）在 L2，因为只有它知道场景对象的当前状态；
 * 推断逻辑（outcome → 候选意图）在 L3。本函数只做「串起来」这件事。
 */
export function finishDemo(ctx: CommandContext, bundle: PredictionBundle): void {
  ctx.stores.demo.set((s) => ({
    ...s,
    recording: false,
    pending: bundle,
    actionCount: bundle.outcome.touchedIds.length,
  }));

  if (!bundle.recognized) {
    ctx.toast('未能从这次示范中识别出明确意图，请手动选择意图类型');
  } else {
    ctx.toast(`已推断出 ${bundle.predictions.length} 个候选意图，请确认`);
  }
}

/** 从示范的结束状态直接建一个步骤（不经过意图推断，用于「就照我调的来」）。 */
export function addStepFromOutcome(ctx: CommandContext, outcome: DemoOutcome, effects: VisualEffects): string | null {
  if (!outcome.selectedId) {
    ctx.toast('示范结束时没有选中任何构件，无法确定讲解目标');
    return null;
  }
  const target = singleTarget(ctx, outcome.selectedId);
  if (!target) return null;

  const camera = ctx.stores.camera.get().pose;
  const step: StoryboardStep = {
    ...createStep(target, `讲解 ${ctx.labelOf(outcome.selectedId)}`),
    camera,
    effects,
    // 有相机就算「已求解」——这机位是作者亲手调的，不存在保真度问题
    solve: camera ? 'solved' : 'none',
    solveNote: camera ? '机位来自作者示范' : '示范中没有相机操作',
    intent: null,
  };

  const sb = currentStoryboard(ctx);
  const next = addStep(sb, step);
  ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next, activeStepId: step.id }));
  ctx.toast('已按示范创建步骤');
  return step.id;
}

// ── 导出 / 校验 ────────────────────────────────────────────────

/** 校验当前分镜（UI 的保存前检查）。 */
export function validateCurrent(ctx: CommandContext): ReturnType<typeof validateStoryboard> {
  const scene = ctx.stores.scene.get().summary;
  const ids = scene ? new Set(scene.components.map((c) => c.id)) : undefined;
  return validateStoryboard(currentStoryboard(ctx), ids);
}

/** 检查分镜与当前模型的兼容性（支撑 C-3）。 */
export function checkCompatibility(ctx: CommandContext): ReturnType<typeof checkModelCompatibility> {
  const model = ctx.stores.model.get();
  return checkModelCompatibility(currentStoryboard(ctx), {
    prefix: model.prefix,
    componentCount: model.componentCount,
  });
}

/** 在分镜上记录来源模型（保存时调用）。 */
export function stampModelRef(ctx: CommandContext): void {
  const model = ctx.stores.model.get();
  const sb = currentStoryboard(ctx);
  ctx.stores.storyboard.set((s) => ({
    ...s,
    storyboard: {
      ...sb,
      modelRef: { name: model.label, componentCount: model.componentCount, modelPrefix: model.prefix },
    },
  }));
}

/** 目标的中文描述（UI 用）。 */
export function targetLabel(ctx: CommandContext, target: TargetRef): string {
  return describeTarget(target, (id) => ctx.labelOf(id));
}

// ── ★ 自然语言指令的执行（开题报告 §3.3「说一句就能改」）─────────

/** 一条指令的执行结果，供界面逐条回显。 */
export interface InstructionOutcome {
  command: EditCommand;
  ok: boolean;
  /** 界面上给作者看的说明（成功说明做了什么，失败说明为什么没做） */
  message: string;
}

/**
 * 执行一组由 `parseEditInstruction` 解析出来的指令。
 *
 * **一条纪律：这里是「语言 → 数据」的唯一落点。** 解析器（L3）只产出数据结构，
 * 不碰 Store；本函数逐条翻译成既有的命令（`moveStepIn`、`setManualIntent`、
 * `redirectStep`…），因此语言通道与手工操作走的是**完全同一条写入路径**——
 * 「改目标必标 stale」「失败不写劣质结果」这些不变量自动成立，不需要在语言通道
 * 里再实现一遍。
 *
 * **失败不中断**：一条指令做不成（如「第 9 步」越界）就记下原因继续下一条，
 * 最后把逐条结果交给界面。作者一次说三件事、其中一件没听懂，不应该丢掉另外两件。
 */
export function applyInstructions(
  ctx: CommandContext,
  commands: EditCommand[],
  context: { activeStepId: string | null },
): InstructionOutcome[] {
  const outcomes: InstructionOutcome[] = [];

  for (const command of commands) {
    outcomes.push(applyOne(ctx, command, context));
  }

  const done = outcomes.filter((o) => o.ok).length;
  if (outcomes.length > 0) {
    ctx.toast(
      done === outcomes.length
        ? `已执行 ${done} 条指令`
        : `已执行 ${done} / ${outcomes.length} 条指令，其余未执行（见列表）`,
    );
  }
  return outcomes;
}

function applyOne(
  ctx: CommandContext,
  command: EditCommand,
  context: { activeStepId: string | null },
): InstructionOutcome {
  const sb = currentStoryboard(ctx);
  const resolveIndex = (): number | null => {
    if (command.stepIndex !== null) {
      const index = command.stepIndex - 1;
      return index >= 0 && index < sb.steps.length ? index : null;
    }
    if (!context.activeStepId) return null;
    const index = sb.steps.findIndex((s) => s.id === context.activeStepId);
    return index >= 0 ? index : null;
  };

  const stepIndex = resolveIndex();
  const step = stepIndex !== null ? sb.steps[stepIndex] : null;

  switch (command.kind) {
    case EditCommandKind.MoveStep: {
      const source = (command.payload?.sourceStepIndex as number | null) ?? null;
      const from = source !== null ? source - 1 : stepIndex;
      if (from === null) {
        return { command, ok: false, message: '没指明要挪动哪一步' };
      }
      if (command.stepIndex === null) {
        return { command, ok: false, message: '没指明要挪到第几步' };
      }
      const to = command.stepIndex - 1;
      // `moveStep` 的 `to` 是**移动后**的下标，因此往后挪时需要减 1——
      // 否则「把第 2 步放到第 4 步」会落到第 5 位（典型的差一错误）
      const adjusted = to > from ? to - 1 : to;
      moveStep(ctx, from, adjusted);
      return { command, ok: true, message: `已把第 ${from + 1} 步移到第 ${to + 1} 位` };
    }

    case EditCommandKind.DeleteStep: {
      if (!step) return { command, ok: false, message: '找不到要删除的步骤' };
      deleteStep(ctx, step.id);
      return { command, ok: true, message: `已删除第 ${stepIndex! + 1} 步「${step.title}」` };
    }

    case EditCommandKind.DuplicateStep: {
      if (!step) return { command, ok: false, message: '找不到要复制的步骤' };
      duplicateStep(ctx, step.id);
      return { command, ok: true, message: `已复制第 ${stepIndex! + 1} 步` };
    }

    case EditCommandKind.SetIntent: {
      if (!step) return { command, ok: false, message: '找不到要改意图的步骤' };
      const kind = command.payload?.intentKind as VisualIntent['kind'] | undefined;
      if (!kind) return { command, ok: false, message: '不知道该设成哪种意图' };
      setManualIntent(ctx, step.id, kind);
      return { command, ok: true, message: `第 ${stepIndex! + 1} 步的意图已设为「${INTENT_LABELS[kind]}」` };
    }

    case EditCommandKind.ReSolve: {
      if (!step) return { command, ok: false, message: '找不到要重解的步骤' };
      if (!step.intent) {
        return { command, ok: false, message: `第 ${stepIndex! + 1} 步还没有意图，无法重解——请先指定意图` };
      }
      const ok = solveStep(ctx, step.id);
      return {
        command,
        ok,
        message: ok
          ? `第 ${stepIndex! + 1} 步已按原意图重新求解`
          : `第 ${stepIndex! + 1} 步重解未通过，请查看失败详情`,
      };
    }

    case EditCommandKind.SetNarration: {
      if (!step) return { command, ok: false, message: '找不到要改旁白的步骤' };
      const narration = command.payload?.narration as string | undefined;
      if (!narration) return { command, ok: false, message: '没有给出新的旁白文本' };
      updateStepText(ctx, step.id, { narration });
      return { command, ok: true, message: `第 ${stepIndex! + 1} 步的旁白已更新` };
    }

    case EditCommandKind.SetDuration: {
      if (!step) return { command, ok: false, message: '找不到要改时长的步骤' };
      const durationMs = command.payload?.durationMs as number | undefined;
      if (!durationMs || durationMs <= 0) return { command, ok: false, message: '时长数值不合法' };
      updateStepText(ctx, step.id, { durationMs });
      return { command, ok: true, message: `第 ${stepIndex! + 1} 步的时长已改为 ${(durationMs / 1000).toFixed(1)} 秒` };
    }

    case EditCommandKind.SetMotion: {
      if (!step) return { command, ok: false, message: '找不到要加运镜的步骤' };
      const degrees = command.payload?.degrees as number | undefined;
      if (!degrees) return { command, ok: false, message: '没有给出环绕角度' };
      setStepMotion(ctx, step.id, orbitMotion(degrees));
      return { command, ok: true, message: `第 ${stepIndex! + 1} 步已设置环绕 ${degrees}°` };
    }

    case EditCommandKind.HideComponents:
    case EditCommandKind.KeepComponents:
    case EditCommandKind.HighlightComponents: {
      if (!step) return { command, ok: false, message: '找不到要调整视觉效果的步骤' };
      if (command.componentIds.length === 0) {
        return { command, ok: false, message: '没识别出要调整哪些构件——请指明构件名（如「柱子」「东侧斗拱」）' };
      }
      const next = applyComponentEffects(ctx, step, command);
      ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next }));
      const verb =
        command.kind === EditCommandKind.HideComponents ? '隐藏'
          : command.kind === EditCommandKind.KeepComponents ? '保留' : '高亮';
      const names = command.componentIds.map((id) => ctx.labelOf(id)).join('、');
      return { command, ok: true, message: `第 ${stepIndex! + 1} 步已${verb}：${names}` };
    }

    case EditCommandKind.Retarget: {
      if (!step) return { command, ok: false, message: '找不到要换目标的步骤' };
      const id = command.componentIds[0];
      if (!id) return { command, ok: false, message: '没识别出新的目标构件' };
      const target = singleTarget(ctx, id);
      if (!target) return { command, ok: false, message: '新目标不在当前模型中' };
      const result = redirectStep(ctx, step.id, target);
      return {
        command,
        ok: result.ok,
        message: result.ok
          ? `第 ${stepIndex! + 1} 步已换成「${ctx.labelOf(id)}」并按原意图重解，保真度 ${Math.round(result.fidelity * 100)}%`
          : `换目标后重解未通过：${result.conflicts[0] ?? '约束无法满足'}`,
      };
    }

    default:
      return { command, ok: false, message: `暂不支持这类指令（${command.kind}）` };
  }
}

/**
 * 把「隐藏/保留/高亮」这三类指令写进步骤的视觉效果。
 *
 * **两条必须遵守的语义**（否则会做出作者没要求的事）：
 *  - 「保留」= 从 `hidden` 与 `transparent` 里**移除**，不是加进 `highlight`。
 *    作者说「别隐藏柱子」时想要的是「柱子照常显示」，不是「柱子发橙光」。
 *  - 「隐藏」= 加进 `hidden` 并**同时**从 `highlight` 与 `transparent` 移除。
 *    一个构件不可能既隐藏又高亮；留着会让播放时的呈现自相矛盾。
 */
function applyComponentEffects(
  ctx: CommandContext,
  step: StoryboardStep,
  command: EditCommand,
): Storyboard {
  const ids = command.componentIds;
  const sb = currentStoryboard(ctx);

  return updateStep(sb, step.id, (s) => {
    const hidden = new Set(s.effects.hidden);
    const highlight = new Set(s.effects.highlight);
    const transparent = new Map(s.effects.transparent.map((t) => [t.id, t.opacity]));

    if (command.kind === EditCommandKind.HideComponents) {
      for (const id of ids) {
        hidden.add(id);
        highlight.delete(id);
        transparent.delete(id);
      }
    } else if (command.kind === EditCommandKind.KeepComponents) {
      for (const id of ids) {
        hidden.delete(id);
        transparent.delete(id);
        highlight.add(id);
      }
    } else {
      for (const id of ids) {
        hidden.delete(id);
        transparent.delete(id);
        highlight.add(id);
      }
    }

    return {
      ...s,
      effects: {
        highlight: [...highlight],
        transparent: [...transparent.entries()].map(([id, opacity]) => ({ id, opacity })),
        hidden: [...hidden],
      },
    };
  });
}

// ── ★ 反馈驱动的局部调整（开题报告 §3.6）────────────────────────

/**
 * 执行一次「反馈 → 归因 → 局部调整」。
 *
 * **与 `applyInstructions` 的区别**：语言指令是「命令式」（「删掉第三步」），
 * 反馈是「评价式」（「这个视角看不清」）。评价需要先归因到四类之一，
 * 而**归因后往往拿不到可执行的动作**（说「看不清」但没说想站哪）——
 * 此时正确的响应是「按原意图重解一次」（换一个候选机位），而不是瞎猜坐标。
 * 这条判断在 L3 的 `diagnoseFeedback` 里做，本函数只负责执行它给出的建议。
 */
export function applyFeedback(
  ctx: CommandContext,
  diagnosis: FeedbackDiagnosis,
  context: { activeStepId: string | null },
): InstructionOutcome {
  const suggestion = diagnosis.suggested;
  if (!suggestion) {
    return {
      command: {
        kind: 'feedback',
        stepIndex: diagnosis.stepIndex,
        componentIds: [],
        confidence: diagnosis.confidence,
        rationale: diagnosis.rationale,
      } as unknown as EditCommand,
      ok: false,
      message: `${diagnosis.rationale}（这一步需要你手动确认后再说一次具体怎么改）`,
    };
  }
  const outcomes = applyInstructions(ctx, [suggestion], context);
  return outcomes[0];
}

// ── ★ 从生成草稿落成分镜（PPT 第 3 页「01 生成」）────────────────

export interface AdoptDraftOutcome {
  /** 新建了多少步 */
  created: number;
  /** 因构件缺失等原因跳过的步数 */
  skipped: number;
  /** 是否需要作者确认（有警告时为真） */
  needsAttention: boolean;
  messages: string[];
}

/**
 * 把一份生成草稿落成**真实的步骤**。
 *
 * **这是「生成」与「编辑」的接缝处，有三件事必须想清楚**：
 *
 *  1. **草稿里没有机位**（见 `GenerationDraft` 的说明），因此新建的步骤是
 *     `solve: 'none'` + `camera: null`，随后由既有求解器按意图求解。
 *     **求解在这里就地做掉**（`solveStep`），因为作者的预期是「点生成 → 立刻能看到
 *     一版可播放的讲解」，而不是「得到一堆待求解的空壳」；
 *  2. **求解失败的步骤保留在分镜里**并标 `failed`，而不是丢弃——FR-19 的立场：
 *     失败要显式暴露，而不是悄悄少一步。界面会把失败原因显示出来；
 *  3. **不删除作者已有的步骤**。生成的结果是**追加**在后面的，作者可以自行取舍。
 *     这避免了「点一下生成，我辛苦编的内容没了」这类不可撤销的破坏。
 */
export function adoptDraft(
  ctx: CommandContext,
  draft: import('../../domain/generator/types.ts').GenerationDraft,
  options: { title?: string } = {},
): AdoptDraftOutcome {
  const messages: string[] = [];
  const scene = ctx.stores.scene.get().summary;
  if (!scene) {
    ctx.toast('场景尚未就绪，无法生成步骤');
    return { created: 0, skipped: 0, needsAttention: true, messages: ['场景尚未就绪'] };
  }

  const sceneIds = new Set(scene.components.map((c) => c.id));
  const createdIds: string[] = [];
  let skipped = 0;

  for (const draftStep of draft.steps) {
    // 草稿在 L3 已经校验过一次构件存在性；这里再核一次是因为**模型可能刚刚换过**
    if (!sceneIds.has(draftStep.targetId)) {
      skipped += 1;
      messages.push(`跳过「${draftStep.title}」：目标构件 ${draftStep.targetId} 不在当前模型里`);
      continue;
    }
    const primary = singleTarget(ctx, draftStep.targetId);
    if (!primary) {
      skipped += 1;
      messages.push(`跳过「${draftStep.title}」：无法解析目标构件`);
      continue;
    }

    // 关系型：两端都在模型里才算关系目标，否则退化为单目标——
    // **退化要说明**，不能让作者以为讲的是关系
    let target: TargetRef = primary;
    if (draftStep.partnerId && sceneIds.has(draftStep.partnerId)) {
      const partnerRef = ctx.refOf(draftStep.partnerId);
      const selfRef = ctx.refOf(draftStep.targetId);
      if (partnerRef && selfRef) {
        target = {
          form: 'relation',
          from: { id: selfRef.id, semantics: selfRef.semantics },
          to: { id: partnerRef.id, semantics: partnerRef.semantics },
          relation: 'stacked',
        };
      }
    } else if (draftStep.partnerId) {
      messages.push(`「${draftStep.title}」的关系端构件不在模型里，已退化为单构件目标`);
    }

    // 意图：用默认谓词组合（与手工选择意图走同一条路）
    const subjectIds = targetIds(target);
    const intent: VisualIntent = {
      id: makeId('intent'),
      kind: draftStep.intentKind,
      predicates: defaultPredicatesFor(draftStep.intentKind, subjectIds.length > 1 ? subjectIds : []),
      provenance: {
        source: 'language',
        confidence: 0.7,
        rationale: `由生成器给出（${draft.generator}）：${draftStep.reason}`,
        confirmedByUser: false,
      },
    };

    const step: StoryboardStep = {
      ...createStep(target, draftStep.title),
      narration: draftStep.narration,
      intent,
      durationMs: draftStep.durationMs,
      motion: draftStep.motionDegrees ? orbitMotion(draftStep.motionDegrees) : null,
      solve: 'stale',
      solveNote: '由生成器创建，等待按意图求解',
    };

    const sb = currentStoryboard(ctx);
    const next = addStep(sb, step);
    ctx.stores.storyboard.set((s) => ({ ...s, storyboard: next, activeStepId: step.id }));
    createdIds.push(step.id);
  }

  // ★ 就地求解：让作者点一次生成就能看到可播放的结果
  let solved = 0;
  let failed = 0;
  for (const id of createdIds) {
    if (solveStep(ctx, id)) solved += 1;
    else failed += 1;
  }

  if (options.title) {
    const sb = currentStoryboard(ctx);
    ctx.stores.storyboard.set((s) => ({ ...s, storyboard: { ...sb, title: options.title! } }));
  }

  messages.push(`已生成 ${createdIds.length} 步，其中 ${solved} 步已求解机位、${failed} 步求解未通过`);
  if (skipped > 0) messages.push(`跳过 ${skipped} 步（见上方明细）`);
  if (draft.warnings.length > 0) messages.push(...draft.warnings);

  ctx.toast(`已生成 ${createdIds.length} 步讲解草稿，${solved} 步已求解`);
  return {
    created: createdIds.length,
    skipped,
    needsAttention: skipped > 0 || failed > 0 || draft.warnings.length > 0,
    messages,
  };
}
