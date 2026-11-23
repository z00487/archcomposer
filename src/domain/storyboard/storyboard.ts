/**
 * L3 领域层 · M6 分镜完整性
 *
 * 依据：《项目概要设计文档》§4.1 的 M6、§5.6、§6.3。
 *
 * **职责**：分镜与步骤的增删复制重排、校验、序列化/反序列化。**全是纯函数**，
 * 因此「重排后绑定有没有被破坏」这类问题可以在 Node 下断言（FR-20）。
 *
 * **一条贯穿全文件的原则：任何改动 target 或 intent 的操作，都必须把该步骤的
 * `solve` 标成 `'stale'`。** 这就是 §5.6 说的「意图可迁移在数据层的证据」——
 * 系统知道自己是「意图已更新、实现待重算」的状态。若忘了标，UI 会显示一个
 * 与当前目标不符的旧机位，而且**没有任何办法察觉**——这正是 Navisworks 的
 * 视点做不到的事。
 */
import type {
  Storyboard,
  StoryboardStep,
  SolveState,
} from '../types/storyboard.ts';
import { SOLVE_STATE_LABELS } from '../types/storyboard.ts';
import { targetIds } from '../types/solver.ts';
import type { TargetRef, VisualEffects } from '../types/solver.ts';
import type { VisualIntent } from '../types/intent.ts';
import type { ComponentId } from '../types/component.ts';
import { makeId } from '../../core/id.ts';
import { clonePose } from '../../core/math.ts';

/** 校验结果。`errors` 会阻断保存，`warnings` 只提示。 */
export interface StoryboardValidation {
  errors: string[];
  warnings: string[];
}

/**
 * 校验整份分镜。
 *
 * **检查项与理由**（每条都对应一个真实的失败场景）：
 *  - 步骤 ID 重复 → 播放调度与 UI 的 key 会错乱，表现为「点第 3 步，第 5 步高亮」
 *  - 空步骤列表 → 播放时无事发生，必须提前告诉用户
 *  - 时长 ≤ 0 → tween 会瞬间完成或抛异常
 *  - `solve === 'solved'` 但 `camera === null` → 状态自相矛盾，说明某处忘了更新状态
 *  - `solve === 'none'/'stale'/'failed'` 但有非空 camera 却未标 stale → 提示可能是漏标
 *  - 目标构件为空 → 步骤讲什么都不知道
 *  - 与当前模型不匹配（modelRef）→ 提示 ID 可能全部失效（支撑 C-3）
 */
export function validateStoryboard(
  storyboard: Storyboard,
  availableIds?: Set<ComponentId>,
): StoryboardValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (storyboard.steps.length === 0) {
    warnings.push('分镜还没有任何步骤，播放时不会发生任何事');
  }

  const seenStepIds = new Set<string>();
  for (const step of storyboard.steps) {
    if (seenStepIds.has(step.id)) {
      errors.push(`步骤 ID 重复：${step.id}`);
    }
    seenStepIds.add(step.id);

    const ids = targetIds(step.target);
    if (ids.length === 0 || ids.some((id) => !id)) {
      errors.push(`步骤「${step.title}」没有指定目标构件`);
    }

    if (step.durationMs <= 0) {
      errors.push(`步骤「${step.title}」的时长必须大于 0（当前 ${step.durationMs}ms）`);
    }

    if (step.solve === 'solved' && step.camera === null) {
      errors.push(`步骤「${step.title}」标记为已求解，但没有相机位姿——状态自相矛盾`);
    }

    if ((step.solve === 'none' || step.solve === 'stale' || step.solve === 'failed') && step.camera !== null) {
      if (step.solve === 'none') {
        warnings.push(`步骤「${step.title}」状态是「未求解」但已有机位，可能是状态漏标`);
      }
    }

    if (step.intent === null) {
      warnings.push(`步骤「${step.title}」还没有意图，重定向时无法保持意图`);
    }

    if (step.intent && step.intent.predicates.length === 0) {
      warnings.push(`步骤「${step.title}」的意图没有任何约束谓词，等于无意图`);
    }

    if (availableIds) {
      const missing = ids.filter((id) => !availableIds.has(id));
      if (missing.length > 0) {
        warnings.push(
          `步骤「${step.title}」引用了当前模型中不存在的构件：${missing.join('、')}`,
        );
      }
    }
  }

  // 关系型目标的合理性检查：REVEAL_RELATION 需要一个二元目标
  for (const step of storyboard.steps) {
    if (step.intent?.kind === 'REVEAL_RELATION' && step.target.form !== 'relation') {
      warnings.push(
        `步骤「${step.title}」的意图是「揭示构件关系」，但目标只指定了单个构件——重解多半会失败`,
      );
    }
    if (step.target.form === 'relation' && step.target.from.id === step.target.to.id) {
      errors.push(`步骤「${step.title}」的关系两端指向了同一个构件`);
    }
  }

  return { errors, warnings };
}

/**
 * 与模型兼容性检查（支撑 C-3）。
 *
 * **为什么需要它**：分镜里的构件 ID 是 `<前缀>@<格式版本>/<构件名>`（文档三 §7.1），
 * 因此换一个模型（前缀或版本不同）后 ID 会全部对不上。系统应当**立刻告知**，
 * 而不是等到播放时才发现「每个步骤都找不到构件」。
 */
export function checkModelCompatibility(
  storyboard: Storyboard,
  model: { prefix: string; componentCount: number },
): { compatible: boolean; reason: string } {
  if (!storyboard.modelRef) {
    return { compatible: true, reason: '分镜未记录来源模型，无法校验（可能是早期版本的文件）' };
  }
  if (storyboard.modelRef.modelPrefix !== model.prefix) {
    return {
      compatible: false,
      reason: `分镜来自模型「${storyboard.modelRef.modelPrefix}」，当前模型是「${model.prefix}」——构件 ID 前缀不同，所有步骤的绑定都会失效`,
    };
  }
  if (storyboard.modelRef.componentCount !== model.componentCount) {
    return {
      compatible: false,
      reason: `分镜记录的构件数是 ${storyboard.modelRef.componentCount}，当前模型是 ${model.componentCount}——模型内容已变化，绑定可能部分失效`,
    };
  }
  return { compatible: true, reason: '' };
}

// ── 步骤的增删复制重排（FR-8）──────────────────────────────────

/** 追加一个步骤。返回新的分镜对象（不可变更新，见 core/store.ts 的说明）。 */
export function addStep(storyboard: Storyboard, step: StoryboardStep, at?: number): Storyboard {
  const steps = [...storyboard.steps];
  const index = at === undefined ? steps.length : clampIndex(at, steps.length);
  steps.splice(index, 0, step);
  return { ...storyboard, steps };
}

export function removeStep(storyboard: Storyboard, stepId: string): Storyboard {
  return { ...storyboard, steps: storyboard.steps.filter((s) => s.id !== stepId) };
}

/**
 * 复制一个步骤。
 *
 * **复制时必须把 `solve` 标回 `'solved'`**（而不是 `'stale'`）：副本的 target、
 * intent、camera 三者是一致的（它是原步骤的完整拷贝），所以不存在「待重算」。
 * 新 ID 是必须的——共用 ID 会让删除一个步骤时连带删掉另一个。
 */
export function duplicateStep(storyboard: Storyboard, stepId: string): Storyboard {
  const index = storyboard.steps.findIndex((s) => s.id === stepId);
  if (index < 0) return storyboard;
  const source = storyboard.steps[index];
  const copy: StoryboardStep = {
    ...source,
    id: makeId('step'),
    title: `${source.title} 副本`,
    target: cloneTarget(source.target),
    intent: cloneIntent(source.intent),
    camera: source.camera ? clonePose(source.camera) : null,
    effects: cloneEffects(source.effects),
  };
  const steps = [...storyboard.steps];
  steps.splice(index + 1, 0, copy);
  return { ...storyboard, steps };
}

export function moveStep(storyboard: Storyboard, from: number, to: number): Storyboard {
  const steps = [...storyboard.steps];
  if (from < 0 || from >= steps.length) return storyboard;
  const target = clampIndex(to, steps.length - 1);
  const [moved] = steps.splice(from, 1);
  steps.splice(target, 0, moved);
  return { ...storyboard, steps };
}

/** 就地替换一个步骤（内部用不可变数组重建）。 */
export function replaceStep(
  storyboard: Storyboard,
  stepId: string,
  patch: Partial<StoryboardStep>,
): Storyboard {
  let touched = false;
  const steps = storyboard.steps.map((s) => {
    if (s.id !== stepId) return s;
    touched = true;
    return { ...s, ...patch };
  });
  return touched ? { ...storyboard, steps } : storyboard;
}

export function updateStep(
  storyboard: Storyboard,
  stepId: string,
  updater: (step: StoryboardStep) => StoryboardStep,
): Storyboard {
  let touched = false;
  const steps = storyboard.steps.map((s) => {
    if (s.id !== stepId) return s;
    touched = true;
    return updater(s);
  });
  return touched ? { ...storyboard, steps } : storyboard;
}

export function findStep(storyboard: Storyboard, stepId: string): StoryboardStep | null {
  return storyboard.steps.find((s) => s.id === stepId) ?? null;
}

// ── ★ 意图保持重定向的核心数据操作（FR-16、§6.2 步骤 ①②）────────

/**
 * 改变步骤的目标，**意图原封不动**，并把状态标成 `'stale'`。
 *
 * 这是整篇论文的技术心脏在数据层的落点。函数的实现只有几行，但它的**语义**
 * 是全部的重点：
 *
 *  - `intent` 一个字段都不碰（§6.2 立场 1：意图只能由用户改）；
 *  - `camera` **保留**（旧机位是重解时的种子，通常比随机初值更快收敛）；
 *  - `solve` 立刻变 `'stale'`（UI 会把这一步标黄，作者知道它需要重算）。
 *
 * 对比 Navisworks：它的视点是一个静态快照，模型变了它不会知道、也无法表达
 * 「我该重算了」——它连一个能表达这个状态的字段都没有。
 */
export function retargetStep(storyboard: Storyboard, stepId: string, newTarget: TargetRef): Storyboard {
  return updateStep(storyboard, stepId, (step) => ({
    ...step,
    target: newTarget,
    solve: markStale(step.solve),
    solveNote: '目标已更换，意图保持不变，需要重新求解',
  }));
}

/**
 * 修改步骤的意图，同样标 `'stale'`。
 *
 * 「意图只能由用户改」——因此这个函数只应由意图确认对话框（FR-14）调用，
 * 绝不应由求解器或推断器调用。求解器改了意图就等于「擅自改题」，
 * 那「意图保持」就成了空话。
 */
export function updateIntent(
  storyboard: Storyboard,
  stepId: string,
  intent: VisualIntent,
): Storyboard {
  return updateStep(storyboard, stepId, (step) => ({
    ...step,
    intent,
    solve: markStale(step.solve),
    solveNote: '意图已修改，需要重新求解',
  }));
}

/**
 * 状态迁移：未求解的步骤改目标后**仍是**未求解（不能无中生有地变成「待重算」）。
 * 这是一个容易写错的细节——统一收在这里，避免每个调用点各判一遍。
 */
export function markStale(state: SolveState): SolveState {
  return state === 'none' ? 'none' : 'stale';
}

/** 求解成功后写入结果（由 M11 调用）。 */
export function applySolveResult(
  storyboard: Storyboard,
  stepId: string,
  result: { camera: import('../types/geometry.ts').Pose | null; effects: VisualEffects; note: string; ok: boolean },
): Storyboard {
  return updateStep(storyboard, stepId, (step) =>
    result.ok && result.camera
      ? {
          ...step,
          camera: result.camera,
          effects: result.effects,
          solve: 'solved',
          solveNote: result.note,
        }
      : {
          // ★ 失败时**不写入劣质结果**（§6.2 步骤 ⑥）
          ...step,
          solve: 'failed',
          solveNote: result.note,
        },
  );
}

/**
 * ★ §6.2 步骤 ⑦：非同类构件替换的警告。
 *
 * **为什么放在领域层而不是命令层**：这是一条关于「目标引用」的数据规则
 * （kind 不同意味着原构图约束未必成立），不依赖任何运行时对象，因此可以在
 * Node 下单测——正是约束 C-1 想要的形态。
 *
 * **为什么是「警告」而不是「拒绝」**：用强调斗拱的构图去拍屋顶虽然多半无意义，
 * 但**也可能正是作者想要的**。系统不该替作者否决，只该提醒（§6.2 步骤 ⑦）。
 * 返回 `null` 表示无需警告。
 */
export function checkKindChange(oldTarget: TargetRef, newTarget: TargetRef): string | null {
  if (oldTarget.form !== 'single' || newTarget.form !== 'single') return null;
  const oldKind = oldTarget.component.semantics.kind;
  const newKind = newTarget.component.semantics.kind;
  if (oldKind === newKind) return null;
  return `新目标的类型是「${newKind}」，与原目标「${oldKind}」不同——原本为「${oldKind}」设计的构图约束未必仍然成立，请确认`;
}

// ── 克隆 ───────────────────────────────────────────────────────

export function cloneTarget(target: TargetRef): TargetRef {
  return target.form === 'single'
    ? { form: 'single', component: { id: target.component.id, semantics: { ...target.component.semantics } } }
    : {
        form: 'relation',
        from: { id: target.from.id, semantics: { ...target.from.semantics } },
        to: { id: target.to.id, semantics: { ...target.to.semantics } },
        relation: target.relation,
      };
}

export function cloneIntent(intent: VisualIntent | null): VisualIntent | null {
  if (!intent) return null;
  return {
    ...intent,
    predicates: intent.predicates.map((p) => ({
      ...p,
      subjects: [...p.subjects],
      test: p.test.op === 'in'
        ? { op: 'in', value: [...p.test.value] as [number, number] }
        : { ...p.test },
    })),
    provenance: { ...intent.provenance },
  };
}

export function cloneEffects(effects: VisualEffects): VisualEffects {
  return {
    highlight: [...effects.highlight],
    transparent: effects.transparent.map((t) => ({ ...t })),
    hidden: [...effects.hidden],
  };
}

function clampIndex(index: number, max: number): number {
  if (!Number.isFinite(index)) return max;
  return Math.max(0, Math.min(Math.trunc(index), max));
}

// ── 便于 UI 的派生信息 ────────────────────────────────────────

export interface StoryboardStats {
  total: number;
  solved: number;
  stale: number;
  failed: number;
  none: number;
  totalDurationMs: number;
}

export function storyboardStats(storyboard: Storyboard): StoryboardStats {
  const stats: StoryboardStats = {
    total: storyboard.steps.length,
    solved: 0,
    stale: 0,
    failed: 0,
    none: 0,
    totalDurationMs: 0,
  };
  for (const step of storyboard.steps) {
    stats[step.solve] += 1;
    stats.totalDurationMs += step.durationMs;
  }
  return stats;
}

/** 步骤的副标题，UI 里显示在标题下方。 */
export function describeStep(step: StoryboardStep, labelOf: (id: ComponentId) => string): string {
  const targetIds_ = targetIds(step.target);
  const targetText = targetIds_.map(labelOf).join(' / ');
  const stateText = SOLVE_STATE_LABELS[step.solve];
  const intentText = step.intent ? step.intent.provenance.rationale || step.intent.kind : '未指定意图';
  return `${targetText} · ${intentText} · ${stateText}`;
}
