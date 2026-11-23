/**
 * L4 命令层的编排测试（`app/commands/commands.ts`）。
 *
 * **这个文件补的是前面测试的一个结构性缺口。** `redirect.test.ts` 测的是
 * **领域层**的重定向原语（retargetStep / 保真度 / 求解器），但论文核心流程真正的
 * 落点在**命令层**：它才负责「按顺序调这些原语，并在失败时不写入劣质结果」。
 * 二者之间最容易出错的恰恰是**编排**——顺序反了、判定条件少了一项、
 * 失败路径忘了保留旧状态，领域层的测试一个都发现不了。
 *
 * 因此这里用一个**假的 CommandContext**（不需要浏览器、不需要 three、
 * 不需要 WebGL）把 L4 完整跑一遍。`EffectManager` 只以类型形式出现，
 * 运行时传个空壳即可——这正是「命令层不 import three」这条纪律带来的可测性。
 */
import { describe, it, expect } from 'vitest';

import {
  addStepFromSelection,
  buildSolveRequest,
  candidateCandidates,
  clearIntent,
  deleteStep,
  duplicateStep,
  finishDemo,
  redirectStep,
  replaceWithSameKind,
  setManualIntent,
  solveStep,
  stepSummaries,
  updateStepText,
  validateCurrent,
  type CommandContext,
} from '../app/commands/commands.ts';
import { createAppStores } from '../app/stores/stores.ts';
import { createDefaultRegistry } from '../domain/solver/registry.ts';
import { toSceneComponentLike } from './helpers.ts';
import { testScene, singleTarget, semantics } from './fixtures.ts';
import { IntentKind, defaultPredicatesFor } from '../domain/types/intent.ts';
import type { ComponentId } from '../domain/types/component.ts';
import type { SceneSummary, TargetRef, VisualEffects } from '../domain/types/solver.ts';
import { EMPTY_EFFECTS } from '../domain/types/solver.ts';
import { resetIdCounter } from '../core/id.ts';
import { computeContextIds } from '../domain/solver/context.ts';
import { deriveSemantics } from '../domain/naming/naming.ts';

// ── 假宿主（一张小场景 + 记录调用的桩）────────────────────────

const SCENE: SceneSummary = testScene(1.6);

/**
 * 从**实际传入的场景**建立 ID → 语义 的索引。
 *
 * ⚠️ 这里必须由参数算，不能引用模块级的 `SCENE`：测试里会传入
 * 「在原场景上多加一个同类构件」的变体，若索引取自模块常量，
 * 新加的构件在 `refOf` 里就会解析不到（返回 null），
 * 于是 `redirectStep` 会拿着一个 `component: null` 的目标往下走并在
 * `checkKindChange` 里崩溃——那是**夹具的错**，不是被测代码的错。
 */
function indexOf(scene: SceneSummary): Record<ComponentId, ReturnType<typeof semantics>> {
  return Object.fromEntries(scene.components.map((c) => [c.id, c.semantics]));
}

interface Harness {
  ctx: CommandContext;
  appliedCameras: Array<{ position: [number, number, number] }>;
  focused: ComponentId[];
  toasts: string[];
  appliedEffects: VisualEffects[];
}

function harness(scene: SceneSummary = SCENE): Harness {
  resetIdCounter();
  const stores = createAppStores();
  const COMPONENTS = indexOf(scene);

  // L3 需要场景摘要；这里直接塞入夹具，跳过 L2 的 toSceneSummary
  stores.scene.set(() => ({ summary: scene, aspect: scene.aspect }));

  const appliedCameras: Harness['appliedCameras'] = [];
  const focused: ComponentId[] = [];
  const toasts: string[] = [];
  const appliedEffects: VisualEffects[] = [];

  const ctx: CommandContext = {
    stores,
    registry: createDefaultRegistry(),
    // 命令层只通过这个接口调 L2；真实场景里是 EffectManager，这里用记录桩
    effects: {
      apply: (effects: VisualEffects) => {
        appliedEffects.push(effects);
      },
      capture: () => EMPTY_EFFECTS,
      attach: () => {},
    } as never,
    refOf: (id) => (COMPONENTS[id] ? { id, semantics: COMPONENTS[id] } : null),
    labelOf: (id) => (COMPONENTS[id] ? `${COMPONENTS[id].kind} ${COMPONENTS[id].part}` : id),
    applyCamera: (pose) => {
      appliedCameras.push(pose as never);
    },
    focusOn: (id) => {
      focused.push(id);
    },
    toast: (message) => {
      toasts.push(message);
    },
  };

  return { ctx, appliedCameras, focused, toasts, appliedEffects };
}

/** 建一个有意图、已求解的步骤（重定向的起点）。 */
function solvedStep(h: Harness, targetId = 'hall@1/column_c__01', kind = IntentKind.Emphasize): string {
  h.ctx.stores.selection.set((s) => ({ ...s, selectedId: targetId }));
  const stepId = addStepFromSelection(h.ctx)!;
  setManualIntent(h.ctx, stepId, kind);
  solveStep(h.ctx, stepId);
  return stepId;
}

/** 模块级索引，供测试直接构造关系型目标时取语义用（只读，取自标准场景）。 */
const IDX = indexOf(SCENE);

const stepOf = (h: Harness, id: string) =>
  h.ctx.stores.storyboard.get().storyboard.steps.find((s) => s.id === id)!;

// ── 步骤的增删改（FR-8）──────────────────────────────────────

describe('步骤增删改的命令层行为', () => {
  it('没有选中构件时新建步骤会被拒绝，并给出提示', () => {
    const h = harness();
    expect(addStepFromSelection(h.ctx)).toBeNull();
    expect(h.toasts.at(-1)).toContain('请先在场景中选择一个构件');
  });

  it('★ 新建的步骤状态是「未求解」而不是「求解失败」', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    const step = stepOf(h, stepId);
    expect(step.solve).toBe('none');
    expect(step.camera).toBeNull();
    expect(step.intent).toBeNull();
  });

  it('新建时带意图则先标为「待重算」（意图已定，机位未解）', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const intent = {
      id: 'i1',
      kind: IntentKind.Emphasize,
      predicates: defaultPredicatesFor(IntentKind.Emphasize),
      provenance: { source: 'manual' as const, confidence: 1, rationale: '手选', confirmedByUser: true },
    };
    const stepId = addStepFromSelection(h.ctx, intent)!;
    expect(stepOf(h, stepId).solve).toBe('stale');
  });

  it('删除步骤后 activeStepId 会落到剩下的第一个步骤', () => {
    const h = harness();
    const a = solvedStep(h);
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/columnbase_e__01' }));
    const b = solvedStep(h, 'hall@1/columnbase_e__01');
    h.ctx.stores.storyboard.set((s) => ({ ...s, activeStepId: a }));
    deleteStep(h.ctx, a);
    const state = h.ctx.stores.storyboard.get();
    expect(state.storyboard.steps.length).toBe(1);
    expect(state.activeStepId).toBe(b);
  });

  it('复制步骤：新 ID、标题带「副本」、状态保持已求解', () => {
    const h = harness();
    const a = solvedStep(h);
    duplicateStep(h.ctx, a);
    const steps = h.ctx.stores.storyboard.get().storyboard.steps;
    expect(steps.length).toBe(2);
    expect(steps[1].id).not.toBe(steps[0].id);
    expect(steps[1].title).toContain('副本');
    // 副本的 target/intent/camera 三者一致，不存在「待重算」
    expect(steps[1].solve).toBe('solved');
  });

  it('改标题/旁白不改变求解状态（不触发重算）', () => {
    const h = harness();
    const a = solvedStep(h);
    const cameraBefore = stepOf(h, a).camera;
    updateStepText(h.ctx, a, { title: '换个说法', narration: '这是旁白' });
    const step = stepOf(h, a);
    expect(step.title).toBe('换个说法');
    expect(step.narration).toBe('这是旁白');
    expect(step.solve).toBe('solved');
    expect(step.camera).toEqual(cameraBefore);
  });

  it('stepSummaries 为每一步产出一句副标题', () => {
    const h = harness();
    solvedStep(h);
    const summaries = stepSummaries(h.ctx);
    expect(summaries.length).toBe(1);
    expect(summaries[0].subtitle.length).toBeGreaterThan(0);
  });
});

// ── 意图设置 ─────────────────────────────────────────────────

describe('意图设置的命令层行为', () => {
  it('★ 手动设置意图会被标成「用户确认」（provenance.confirmedByUser）', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    setManualIntent(h.ctx, stepId, IntentKind.ShowOverview as never);
    const intent = stepOf(h, stepId).intent!;
    expect(intent.kind).toBe(IntentKind.ShowOverview);
    expect(intent.provenance.confirmedByUser).toBe(true);
    expect(intent.provenance.source).toBe('manual');
    expect(intent.provenance.rationale).toContain('手动指定');
    // ★ 注意：这一步建出来时是「未求解」（none），而 markStale(none) 仍是 none。
    //   这是**正确的**——一个还从未求解过的步骤，不该被说成「待重算」；
    //   「待重算」的前提是「原来算过、现在失效了」。这条语义由
    //   `markStale` 的实现与 storyboard.test.ts 的一组测试共同锁住。
    expect(stepOf(h, stepId).solve).toBe('none');
  });

  it('★ 对**已求解**的步骤改意图，才会标成「待重算」', () => {
    const h = harness();
    const stepId = solvedStep(h);
    expect(stepOf(h, stepId).solve).toBe('solved');
    setManualIntent(h.ctx, stepId, IntentKind.KeepContext as never);
    expect(stepOf(h, stepId).solve).toBe('stale');
    expect(stepOf(h, stepId).solveNote).toContain('意图已修改');
  });

  it('★ 清除意图会标「待重算」，但不把已求解的步骤变回「未求解」', () => {
    const h = harness();
    const stepId = solvedStep(h);
    clearIntent(h.ctx, stepId);
    const step = stepOf(h, stepId);
    expect(step.intent).toBeNull();
    expect(step.solve).toBe('stale');
  });

  it('关系型目标的手动意图会把两端的构件 ID 作为约束主体', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    // 换成关系型目标
    h.ctx.stores.storyboard.set((s) => ({
      ...s,
      storyboard: {
        ...s.storyboard,
        steps: s.storyboard.steps.map((step) =>
          step.id === stepId
            ? {
                ...step,
                target: {
                  form: 'relation' as const,
                  from: { id: 'hall@1/column_c__01', semantics: IDX['hall@1/column_c__01'] },
                  to: { id: 'hall@1/roof_front', semantics: IDX['hall@1/roof_front'] },
                  relation: 'bear' as const,
                },
              }
            : step,
        ),
      },
    }));
    setManualIntent(h.ctx, stepId, IntentKind.RevealRelation as never);
    const intent = stepOf(h, stepId).intent!;
    // 关系意图的谓词必须显式指定两端，否则无从判断「同框」
    const subjects = intent.predicates.flatMap((p) => p.subjects);
    expect(subjects).toContain('hall@1/column_c__01');
    expect(subjects).toContain('hall@1/roof_front');
  });
});

// ── 求解 ─────────────────────────────────────────────────────

describe('求解的命令层行为', () => {
  it('没有意图时求解会被拒绝并提示', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    expect(solveStep(h.ctx, stepId)).toBe(false);
    expect(h.toasts.at(-1)).toContain('还没有意图');
  });

  it('场景未就绪时求解被拒绝', () => {
    const h = harness();
    h.ctx.stores.scene.set(() => ({ summary: null }));
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    setManualIntent(h.ctx, stepId, IntentKind.Emphasize as never);
    expect(solveStep(h.ctx, stepId)).toBe(false);
    expect(h.toasts.at(-1)).toContain('场景尚未就绪');
  });

  it('★ 求解成功后：写相机、标已求解、把机位应用到视口', () => {
    const h = harness();
    const stepId = solvedStep(h);
    const step = stepOf(h, stepId);
    expect(step.solve).toBe('solved');
    expect(step.camera).not.toBeNull();
    expect(h.appliedCameras.length).toBe(1);
    expect(h.focused).toContain('hall@1/column_c__01');
    expect(h.appliedEffects.length).toBe(1);
  });

  it('★ 求解失败时：不写相机、不动机位、状态是 failed（FR-19）', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    // 构造一条不可能满足的约束
    h.ctx.stores.storyboard.set((s) => ({
      ...s,
      storyboard: {
        ...s.storyboard,
        steps: s.storyboard.steps.map((step) =>
          step.id === stepId
            ? {
                ...step,
                intent: {
                  id: 'i',
                  kind: IntentKind.Emphasize,
                  predicates: [
                    { measure: 'screenCoverage' as const, subjects: [], test: { op: '>=' as const, value: 3 }, weight: 1 },
                  ],
                  provenance: { source: 'manual' as const, confidence: 1, rationale: 'x', confirmedByUser: true },
                },
              }
            : step,
        ),
      },
    }));

    const ok = solveStep(h.ctx, stepId);
    expect(ok).toBe(false);
    const step = stepOf(h, stepId);
    expect(step.solve).toBe('failed');
    expect(step.camera).toBeNull();
    // 失败路径**不改视口**——不把凑合的结果推给用户看
    expect(h.appliedCameras.length).toBe(0);
    expect(h.appliedEffects.length).toBe(0);
    expect(step.solveNote).toContain('求解失败');
  });

  it('buildSolveRequest 的种子优先取步骤里已有的机位（重解的起点）', () => {
    const h = harness();
    const stepId = solvedStep(h);
    const step = stepOf(h, stepId);
    const request = buildSolveRequest(h.ctx, step, step.intent!)!;
    expect(request.seed).toEqual(step.camera);
    expect(request.target).toEqual(step.target);
  });

  it('buildSolveRequest 在场景未就绪时返回 null 并提示', () => {
    const h = harness();
    h.ctx.stores.scene.set(() => ({ summary: null }));
    const step = { id: 'x', target: singleTarget('hall@1/column_c__01') } as never;
    const intent = {
      id: 'i',
      kind: IntentKind.Emphasize,
      predicates: defaultPredicatesFor(IntentKind.Emphasize),
      provenance: { source: 'manual' as const, confidence: 1, rationale: 'x', confirmedByUser: true },
    };
    expect(buildSolveRequest(h.ctx, step, intent)).toBeNull();
    expect(h.toasts.at(-1)).toContain('场景尚未就绪');
  });
});

// ── ★ 重定向（FR-16 ~ FR-19）───────────────────────────────────

describe('★ redirectStep：命令层的七步编排', () => {
  it('找不到步骤时返回失败而不是抛异常', () => {
    const h = harness();
    const result = redirectStep(h.ctx, '不存在的步骤', singleTarget('hall@1/roof_front'));
    expect(result.ok).toBe(false);
    expect(result.warnings).toContain('找不到该步骤');
  });

  it('场景未就绪时返回失败', () => {
    const h = harness();
    const stepId = solvedStep(h);
    h.ctx.stores.scene.set(() => ({ summary: null }));
    const result = redirectStep(h.ctx, stepId, singleTarget('hall@1/roof_front'));
    expect(result.ok).toBe(false);
    expect(result.warnings).toContain('场景尚未就绪');
  });

  it('★ 成功路径：换目标 → 意图不变 → 重解 → 写入 → 视口跟随', () => {
    // 用一个「有两根同类柱子」的场景：换同类构件才是重定向的典型用例，
    // 也不会触发「新目标类型不同」的警告（那条另有一条测试）
    const secondColumn = toSceneComponentLike('hall@1/column_e__01', 'column');
    const h = harness({ ...SCENE, components: [...SCENE.components, secondColumn] });
    const stepId = solvedStep(h, 'hall@1/column_c__01');
    const intentBefore = JSON.parse(JSON.stringify(stepOf(h, stepId).intent));

    const result = redirectStep(h.ctx, stepId, singleTarget('hall@1/column_e__01', 'column'));

    expect(result.ok).toBe(true);
    expect(result.fidelity).toBeGreaterThanOrEqual(0.65);
    const step = stepOf(h, stepId);
    // ① 目标换了
    expect(step.target.form === 'single' && step.target.component.id).toBe('hall@1/column_e__01');
    // ② ★ 意图**逐字段未变**（这是整篇论文的主张）
    expect(step.intent).toEqual(intentBefore);
    // 目标项里挂着的 semantics 缓存也被换成了新目标的（它是引用的一部分，不是意图的一部分）
    expect(step.intent!.kind).toBe(intentBefore.kind);
    expect(step.intent!.predicates).toEqual(intentBefore.predicates);
    // ⑥ 机位被重解（新的，不是旧的）
    expect(step.solve).toBe('solved');
    expect(step.camera).not.toBeNull();
    // 视口跟随新目标
    expect(h.focused).toContain('hall@1/column_e__01');
    // 同类构件之间替换：不产生「类型不同」的警告
    expect(result.warnings).toEqual([]);
  });

  it('★ 失败路径：不写入劣质机位、保留旧相机、状态为 failed', () => {
    const h = harness();
    const stepId = solvedStep(h);
    const oldCamera = JSON.parse(JSON.stringify(stepOf(h, stepId).camera));
    const cameraCountBefore = h.appliedCameras.length;

    // 目标换成场景里**不存在**的构件 → 求解必然拿不到任何可见目标
    const ghost: TargetRef = {
      form: 'single',
      component: { id: 'hall@1/ghost__99', semantics: semantics('column') },
    };
    const result = redirectStep(h.ctx, stepId, ghost);

    expect(result.ok).toBe(false);
    const step = stepOf(h, stepId);
    expect(step.solve).toBe('failed');
    // ★ 不写入新机位：camera 保持原样（它是重解的种子与已确认的成果）
    expect(step.camera).toEqual(oldCamera);
    // ★ 不推给视口
    expect(h.appliedCameras.length).toBe(cameraCountBefore);
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it('★ 失败路径的提示要说清「保留原状态」，而不是让用户以为改了', () => {
    const h = harness();
    const stepId = solvedStep(h);
    const ghost: TargetRef = {
      form: 'single',
      component: { id: 'hall@1/ghost__99', semantics: semantics('column') },
    };
    redirectStep(h.ctx, stepId, ghost);
    const step = stepOf(h, stepId);
    expect(step.solveNote).toContain('失败');
    // 目标确实换了（作者的意图是明确的），失败的只是「自动构图」这一步
    expect(step.target.form === 'single' && step.target.component.id).toBe('hall@1/ghost__99');
  });

  it('★ 跨类替换：仍然执行、仍然可能求解成功，只是多一条警告（提醒而非否决）', () => {
    const h = harness();
    const stepId = solvedStep(h);
    const result = redirectStep(h.ctx, stepId, singleTarget('hall@1/columnbase_e__01', 'columnbase'));
    expect(result.warnings.length).toBe(1);
    // 关键：警告**没有**阻止流程 —— 求解照常进行，结果该成功就成功
    const step = stepOf(h, stepId);
    expect(['solved', 'failed']).toContain(step.solve);
    expect(step.target.form === 'single' && step.target.component.id).toBe('hall@1/columnbase_e__01');
  });

  it('★ 非同类构件：给出警告但仍执行（提醒而非否决）', () => {
    const h = harness();
    const stepId = solvedStep(h); // 目标是 column
    const result = redirectStep(h.ctx, stepId, singleTarget('hall@1/roof_front', 'roof'));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('column');
    expect(result.warnings[0]).toContain('roof');
    // 警告不阻止操作：目标确实换了，流程走下去了
    const step = stepOf(h, stepId);
    expect(step.target.form === 'single' && step.target.component.id).toBe('hall@1/roof_front');
    expect(['solved', 'failed']).toContain(step.solve);
  });

  it('★ 步骤没有意图时：标 stale 并如实说明无法重解（不假装成功）', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!; // 无意图、未求解
    const result = redirectStep(h.ctx, stepId, singleTarget('hall@1/columnbase_e__01', 'columnbase'));
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('还没有意图'))).toBe(true);
    // 未求解的步骤改目标后仍是「未求解」——不无中生有地变成「待重算」
    expect(stepOf(h, stepId).solve).toBe('none');
  });

  it('★ 重定向过程中会先标 stale（数据层立即反映「实现已失效」）', () => {
    const h = harness();
    const stepId = solvedStep(h);
    // 用一个在 solve 时会抛异常的求解器，把执行卡在「标完 stale 之后、求解之前」
    const registry = h.ctx.registry;
    registry.register(
      {
        name: 'boom',
        solve() {
          throw new Error('boom');
        },
      } as never,
      false,
    );
    registry.setDefault('boom');

    expect(() => redirectStep(h.ctx, stepId, singleTarget('hall@1/columnbase_e__01', 'columnbase'))).toThrow();
    // 即便求解器崩了，stale 也已经被写进去了 —— 系统知道这一步需要重算
    const step = stepOf(h, stepId);
    expect(step.solve).toBe('stale');
    expect(step.solveNote).toContain('目标已更换');
  });

  it('replaceWithSameKind：自动挑一个同类构件并重定向', () => {
    const h = harness();
    const stepId = solvedStep(h, 'hall@1/column_c__01');
    const result = replaceWithSameKind(h.ctx, stepId);
    // 夹具里只有一个 column，因此找不到可替换的同类构件——如实报告
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('没有找到可替换的同类构件'))).toBe(true);
  });

  it('★ replaceWithSameKind：有同类候选时会换到**另一个**同类构件上', () => {
    // 造一个有两个 column 的场景
    const extra = toSceneComponentLike('hall@1/column_e__01', 'column');
    const h = harness({ ...SCENE, components: [...SCENE.components, extra] });
    const stepId = solvedStep(h, 'hall@1/column_c__01');
    const candidates = candidateCandidates(h.ctx, stepId);
    expect(candidates).toContain('hall@1/column_e__01');

    const result = replaceWithSameKind(h.ctx, stepId);
    expect(result.ok).toBe(true);
    const step = stepOf(h, stepId);
    expect(step.target.form === 'single' && step.target.component.id).toBe('hall@1/column_e__01');
    // 同类替换不产生「类型不同」的警告
    expect(result.warnings).toEqual([]);
  });

  it('候选列表按「对面的优先」排序（命名规范 §7.3）', () => {
    const east = toSceneComponentLike('hall@1/column_e__01', 'column');
    const north = toSceneComponentLike('hall@1/column_n__01', 'column');
    const h = harness({ ...SCENE, components: [...SCENE.components, east, north] });
    const stepId = solvedStep(h, 'hall@1/column_c__01');
    const candidates = candidateCandidates(h.ctx, stepId);
    // ★ 候选里**不含自己**——否则「换同类构件」会挑到自己，那是一次空操作
    expect(candidates).not.toContain('hall@1/column_c__01');
    expect(new Set(candidates)).toEqual(new Set(['hall@1/column_e__01', 'hall@1/column_n__01']));
    // 稳定性：连查两次结果相同
    expect(candidateCandidates(h.ctx, stepId)).toEqual(candidates);
  });

  it('关系型目标不支持一键换同类构件，会明确告知', () => {
    const h = harness();
    const stepId = solvedStep(h);
    h.ctx.stores.storyboard.set((s) => ({
      ...s,
      storyboard: {
        ...s.storyboard,
        steps: s.storyboard.steps.map((step) =>
          step.id === stepId
            ? {
                ...step,
                target: {
                  form: 'relation' as const,
                  from: { id: 'hall@1/column_c__01', semantics: IDX['hall@1/column_c__01'] },
                  to: { id: 'hall@1/roof_front', semantics: IDX['hall@1/roof_front'] },
                  relation: 'bear' as const,
                },
              }
            : step,
        ),
      },
    }));
    const result = replaceWithSameKind(h.ctx, stepId);
    expect(result.ok).toBe(false);
    expect(result.warnings.some((w) => w.includes('关系型目标'))).toBe(true);
  });

  it('candidateCandidates 对不存在的步骤返回空数组', () => {
    const h = harness();
    expect(candidateCandidates(h.ctx, '不存在')).toEqual([]);
  });

  it('★ 保真度随结果的接口契约：无论成败都返回数值', () => {
    const h = harness();
    const stepId = solvedStep(h);
    const ok = redirectStep(h.ctx, stepId, singleTarget('hall@1/columnbase_e__01', 'columnbase'));
    expect(typeof ok.fidelity).toBe('number');
    expect(Number.isFinite(ok.fidelity)).toBe(true);
  });
});

// ── 示范结束与校验 ─────────────────────────────────────────────

describe('示范结束与校验', () => {
  it('finishDemo 把候选意图放进 Store，并在识别失败时明确提示', () => {
    const h = harness();
    finishDemo(h.ctx, { outcome: { selectedId: null, opacities: {}, hidden: [], highlighted: [], cameraTrack: [], touchedIds: [] }, predictions: [], recognized: false, signals: [] });
    const demo = h.ctx.stores.demo.get();
    expect(demo.recording).toBe(false);
    expect(demo.pending).not.toBeNull();
    expect(h.toasts.at(-1)).toContain('未能从这次示范中识别出明确意图');
  });

  it('finishDemo 识别成功时报告候选数量', () => {
    const h = harness();
    finishDemo(h.ctx, {
      outcome: { selectedId: 'hall@1/column_c__01', opacities: {}, hidden: [], highlighted: [], cameraTrack: [], touchedIds: ['hall@1/column_c__01'] },
      predictions: [{ intent: { id: 'i', kind: IntentKind.Emphasize, predicates: [], provenance: { source: 'demo', confidence: 0.8, rationale: 'r', confirmedByUser: false } }, signals: [] }],
      recognized: true,
      signals: [],
    });
    expect(h.toasts.at(-1)).toContain('1 个候选意图');
  });

  it('★ validateCurrent：没有步骤时是 warning 而不是 error（保存不该被阻断）', () => {
    const h = harness();
    const validation = validateCurrent(h.ctx);
    expect(validation.errors).toEqual([]);
    expect(validation.warnings.length).toBeGreaterThan(0);
  });

  it('★ validateCurrent 能识别出「引用了当前不存在的构件」', () => {
    const h = harness();
    const stepId = solvedStep(h);
    // 把场景换成一个空的：步骤里的构件就都不存在了
    h.ctx.stores.scene.set(() => ({ summary: { ...SCENE, components: [] }, aspect: 1 }));
    const validation = validateCurrent(h.ctx);
    expect(validation.warnings.some((w) => w.includes('不存在'))).toBe(true);
    void stepId;
  });
});

// ── 分层纪律的验证 ─────────────────────────────────────────────

describe('命令层不依赖 three（约束 C-1 的可测性体现）', () => {
  it('★ 整个文件跑在 node 环境下，没引入任何 three —— 因此编排逻辑可在 CI 里验证', () => {
    // 这条测试的「断言」其实是**它自己能跑起来**这件事：
    // 若 commands.ts 在运行时 import 了 three，本文件在 node 环境下会直接崩。
    // 用一行 printf 把这件事写明白，比默默通过更有意义。
    expect(typeof redirectStep).toBe('function');
    expect(typeof computeContextIds).toBe('function');
    expect(typeof deriveSemantics).toBe('function');
    expect(typeof candidateCandidates).toBe('function');
  });
});
