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
