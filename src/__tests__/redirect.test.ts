/**
 * ★ 端到端：意图保持重定向（FR-16 ~ FR-19，概要设计 §6.2 的七步流程）
 *
 * **这是论文核心主张的可执行证据。** 这个文件把 §6.2 的流程图逐步骤地断言了一遍：
 *
 *   ① 更新 target → ② 标 stale → ③ 构造请求 → ④ 求解 → ⑤ 算保真度
 *   → ⑥ 判定（成功写入 / 失败不写） → ⑦ 非同类构件的警告
 *
 * 它跑在 Node 里、不碰浏览器、不碰 three —— 这正是约束 C-1 存在的全部意义：
 * 「换目标之后意图还在不在」这个问题，可以在 CI 里被机械化地验证。
 */
import { describe, it, expect } from 'vitest';
import { createDefaultRegistry } from '../domain/solver/registry.ts';
import { SamplingSolver } from '../domain/solver/solver.ts';
import { evaluateRedirectionFidelity, FIDELITY_ACCEPT_THRESHOLD } from '../domain/fidelity/fidelity.ts';
import { computeContextIds } from '../domain/solver/context.ts';
import { retargetStep, findStep, applySolveResult, checkKindChange } from '../domain/storyboard/storyboard.ts';
import { createStep, createStoryboard } from '../domain/types/storyboard.ts';
import { IntentKind, defaultPredicatesFor, predicate } from '../domain/types/intent.ts';
import type { VisualIntent } from '../domain/types/intent.ts';
import type { Storyboard } from '../domain/types/storyboard.ts';
import type { TargetRef, SolveResult, ViewSolver } from '../domain/types/solver.ts';
import { testScene, poseLookingNorth, singleTarget, relationTarget } from './fixtures.ts';
import { resetIdCounter } from '../core/id.ts';

const SCENE = testScene(1.6);

/** 一个有意图、已求解的步骤（重定向的起点）。 */
function solvedStep(kind: IntentKind, targetId: string, pose = poseLookingNorth(3, 0.5)) {
  resetIdCounter();
  const intent: VisualIntent = {
    id: 'i1',
    kind,
    predicates: defaultPredicatesFor(kind),
    provenance: { source: 'demo', confidence: 0.8, rationale: '示范推断', confirmedByUser: true },
  };
  const step = { ...createStep(singleTarget(targetId, 'column'), '讲这根柱'), intent, camera: pose, solve: 'solved' as const };
  return { storyboard: { ...createStoryboard('测试'), steps: [step] }, step, intent, pose };
}

/**
 * 一个**不依赖 three 的** redirectStep 等价实现。
 *
 * 为什么在测试里重写而不是直接调 `app/commands/commands.ts` 的版本？
 * 因为那个版本需要 `CommandContext`（含 Viewport、EffectManager 等 L2/L4 对象），
 * 而本文件要证明的恰恰是**「重定向的核心逻辑不需要这些东西」**。
 * 命令层的版本只比这里多一层「把结果应用到视口」的副作用。
 */
function redirect(
  storyboard: Storyboard,
  stepId: string,
  newTarget: TargetRef,
  solver: ViewSolver = new SamplingSolver(),
): { storyboard: Storyboard; result: SolveResult; fidelity: number; accepted: boolean } {
  const before = findStep(storyboard, stepId)!;
  const after1 = retargetStep(storyboard, stepId, newTarget);
  const step = findStep(after1, stepId)!;
  const intent = step.intent!;

  const request = {
    target: newTarget,
    intent,
    scene: SCENE,
    seed: before.camera,
    maxCandidates: 640,
  };
  const result = solver.solve(request);
  const contextIds = computeContextIds(step.target, SCENE);

  let fidelity = result.fidelity.overall;
  if (before.camera && result.camera) {
    fidelity = evaluateRedirectionFidelity(
      { pose: before.camera, effects: before.effects, target: before.target },
      { pose: result.camera, effects: result.effects, target: step.target },
      intent,
      SCENE,
      contextIds,
    ).overall;
  }

  const accepted = result.ok && result.camera !== null && fidelity >= FIDELITY_ACCEPT_THRESHOLD;
  const next = applySolveResult(after1, stepId, {
    camera: result.camera,
    effects: result.effects,
    note: accepted ? `已按原意图重解，保真度 ${Math.round(fidelity * 100)}%` : '重解未通过',
    ok: accepted,
  });
  return { storyboard: next, result, fidelity, accepted };
}

describe('§6.2 步骤 ①②：改目标、意图不变、标 stale', () => {
  it('目标换了，意图逐字段不变', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const beforeIntent = step.intent;

    const after = retargetStep(storyboard, step.id, singleTarget('hall@1/columnbase_e__01', 'columnbase'));
    const updated = findStep(after, step.id)!;

    expect(updated.target.form).toBe('single');
    expect(updated.target.form === 'single' && updated.target.component.id).toBe('hall@1/columnbase_e__01');
    // ★ 逐字段比对：谓词、来源、置信度、理由、确认状态，一个都不能变
    expect(updated.intent).toEqual(beforeIntent);
  });

  it('状态立刻变成 stale（数据层立即反映实现已失效）', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const after = retargetStep(storyboard, step.id, singleTarget('hall@1/columnbase_e__01'));
    expect(findStep(after, step.id)!.solve).toBe('stale');
  });

  it('旧机位被保留下来作为重解的种子', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const after = retargetStep(storyboard, step.id, singleTarget('hall@1/columnbase_e__01'));
    expect(findStep(after, step.id)!.camera).toEqual(step.camera);
  });
});

describe('§6.2 步骤 ③④⑤⑥：求解 → 保真度 → 判定', () => {
  it('★ 同类构件重定向成功：新机位写入、状态回 solved、保真度达标', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const result = redirect(storyboard, step.id, singleTarget('hall@1/columnbase_e__01', 'columnbase'));

    expect(result.accepted).toBe(true);
    expect(result.result.camera).not.toBeNull();
    const finalStep = findStep(result.storyboard, step.id)!;
    expect(finalStep.solve).toBe('solved');
    expect(finalStep.camera).not.toBeNull();
    expect(finalStep.solveNote).toContain('保真度');
    // 意图仍然是原来那个（重定向没有产生新意图对象）
    expect(finalStep.intent!.id).toBe('i1');
  });

  it('★ 保真度是一个 [0,1] 的量化值（FR-18）', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const result = redirect(storyboard, step.id, singleTarget('hall@1/columnbase_e__01', 'columnbase'));
    expect(result.fidelity).toBeGreaterThanOrEqual(0);
    expect(result.fidelity).toBeLessThanOrEqual(1);
    expect(Number.isFinite(result.fidelity)).toBe(true);
  });

  it('★ 求解失败或保真度过低时**不写入劣质结果**（§6.2 立场 3 / FR-19）', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    // 要求画面占比 >= 5：任何候选都做不到
    const impossible: VisualIntent = {
      id: 'i1',
      kind: IntentKind.Emphasize,
      predicates: [predicate.coverageAtLeast(5)],
      provenance: { source: 'manual', confidence: 1, rationale: '人为设成不可满足', confirmedByUser: true },
    };
    const board: Storyboard = {
      ...storyboard,
      steps: storyboard.steps.map((s) => ({ ...s, intent: impossible })),
    };

    const result = redirect(board, step.id, singleTarget('hall@1/columnbase_e__01'));
    expect(result.accepted).toBe(false);
    const finalStep = findStep(result.storyboard, step.id)!;
    expect(finalStep.solve).toBe('failed');
    // 关键：**没有**把那个劣质机位写进去，旧机位原样保留
    expect(finalStep.camera).toEqual(step.camera);
  });

  it('目标根本不在场景中时，重定向失败但数据保持完好', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const result = redirect(storyboard, step.id, singleTarget('hall@1/不存在'));
    expect(result.accepted).toBe(false);
    const finalStep = findStep(result.storyboard, step.id)!;
    expect(finalStep.solve).toBe('failed');
    expect(finalStep.camera).toEqual(step.camera);
  });

  it('关系型目标的保真度低于单目标（约束更难同时满足）', () => {
    const single = (() => {
      const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
      return redirect(storyboard, step.id, singleTarget('hall@1/columnbase_e__01')).fidelity;
    })();

    resetIdCounter();
    const relationIntent: VisualIntent = {
      id: 'i2',
      kind: IntentKind.RevealRelation,
      predicates: defaultPredicatesFor(IntentKind.RevealRelation, ['hall@1/column_c__01', 'hall@1/columnbase_e__01']),
      provenance: { source: 'manual', confidence: 1, rationale: '关系', confirmedByUser: true },
    };
    const relationStep = {
      ...createStep(
        relationTarget('hall@1/column_c__01', 'hall@1/columnbase_e__01'),
        '讲关系',
      ),
      intent: relationIntent,
      camera: poseLookingNorth(12, 3),
      solve: 'solved' as const,
    };
    const board: Storyboard = { ...createStoryboard('关系'), steps: [relationStep] };
    // 换一个更难同框的组合：原点与最远的屋面
    const harder = relationTarget('hall@1/column_c__01', 'hall@1/roof_front');
    const result = redirect(board, relationStep.id, harder);

    // 关系型意图的保真度不会比单目标的简单情形更高
    expect(result.fidelity).toBeLessThanOrEqual(single + 0.01);
  });
});

describe('§6.2 立场 1：意图只能由用户改', () => {
  it('★ 重定向过程不会修改意图的任何一个字段', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const before = JSON.stringify(step.intent);

    // 走完整个重定向流程
    const result = redirect(storyboard, step.id, singleTarget('hall@1/columnbase_e__01', 'columnbase'));
    const finalIntent = JSON.stringify(findStep(result.storyboard, step.id)!.intent);

    expect(finalIntent).toBe(before);
  });

  it('求解器不持有也不修改传入的 intent（无副作用）', () => {
    const { step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const snapshot = JSON.stringify(step.intent);
    const solver = new SamplingSolver();
    solver.solve({ target: step.target, intent: step.intent!, scene: SCENE });
    expect(JSON.stringify(step.intent)).toBe(snapshot);
  });

  it('求解器不修改传入的 scene（SceneSummary 是只读输入）', () => {
    const { step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const snapshot = JSON.stringify(SCENE);
    new SamplingSolver().solve({ target: step.target, intent: step.intent!, scene: SCENE });
    expect(JSON.stringify(SCENE)).toBe(snapshot);
  });
});

describe('§6.2 立场 2：可复现性', () => {
  it('★ 同一重定向操作重复执行，结果逐位相同', () => {
    const a = (() => {
      const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
      return redirect(storyboard, step.id, singleTarget('hall@1/columnbase_e__01', 'columnbase'));
    })();
    const b = (() => {
      const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
      return redirect(storyboard, step.id, singleTarget('hall@1/columnbase_e__01', 'columnbase'));
    })();

    expect(JSON.stringify(a.result.camera)).toBe(JSON.stringify(b.result.camera));
    expect(a.fidelity).toBe(b.fidelity);
    expect(a.accepted).toBe(b.accepted);
  });
});

describe('§6.2 步骤 ⑦：非同类构件的警告', () => {
  it('★ kind 从 column 变成 roof 时给出警告，并把两个类型都写进理由里', () => {
    const warning = checkKindChange(
      singleTarget('hall@1/column_c__01', 'column'),
      singleTarget('hall@1/roof_front', 'roof'),
    );
    expect(warning).not.toBeNull();
    expect(warning).toContain('column');
    expect(warning).toContain('roof');
    // 措辞要说清「警告而非拒绝」的立场：请确认
    expect(warning).toContain('请确认');
  });

  it('同类构件之间不产生警告', () => {
    const warning = checkKindChange(
      singleTarget('hall@1/column_c__01', 'column'),
      singleTarget('hall@1/column_w__02', 'column'),
    );
    expect(warning).toBeNull();
  });

  it('关系型目标不参与这条判定（第一版规则只针对单目标）', () => {
    const warning = checkKindChange(
      relationTarget('hall@1/dougong_se__01', 'hall@1/purlin_e_front_1'),
      singleTarget('hall@1/roof_front', 'roof'),
    );
    expect(warning).toBeNull();
  });

  it('★ 警告不阻止操作：换目标这件事本身照样成立（立场：提醒而非否决）', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    // 即使类型不同，重定向流程仍然会执行并写入结果
    const result = redirect(storyboard, step.id, singleTarget('hall@1/roof_front', 'roof'));
    const finalStep = findStep(result.storyboard, step.id)!;
    expect(finalStep.target.form === 'single' && finalStep.target.component.id).toBe('hall@1/roof_front');
    // 状态不再是原样，说明流程确实走了下去
    expect(['solved', 'failed']).toContain(finalStep.solve);
  });
});

describe('重定向与保真度模块的接口契约', () => {
  it('evaluateRedirectionFidelity 同时给出 before / after / consistency', () => {
    const { step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const result = evaluateRedirectionFidelity(
      { pose: poseLookingNorth(3, 0.5), effects: step.effects, target: step.target },
      { pose: poseLookingNorth(4, 0.5), effects: step.effects, target: singleTarget('hall@1/columnbase_e__01') },
      step.intent!,
      SCENE,
    );
    expect(result.before.report.overall).toBeGreaterThanOrEqual(0);
    expect(result.after.report.overall).toBeGreaterThanOrEqual(0);
    expect(result.consistency).toBeGreaterThanOrEqual(0);
    expect(result.consistency).toBeLessThanOrEqual(1);
    // overall 取「新旧较小者 × 一致性」，因此不超过任一单项
    expect(result.overall).toBeLessThanOrEqual(result.before.report.overall + 1e-9);
    expect(result.overall).toBeLessThanOrEqual(result.after.report.overall + 1e-9);
  });

  it('失败时报告里带逐条冲突，且每条都有人类可读说明', () => {
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const board: Storyboard = {
      ...storyboard,
      steps: storyboard.steps.map((s) => ({
        ...s,
        intent: {
          ...s.intent!,
          predicates: [predicate.coverageAtLeast(3), predicate.unoccluded()],
        },
      })),
    };
    const result = redirect(board, step.id, singleTarget('hall@1/columnbase_e__01'));
    expect(result.result.conflicts.length).toBeGreaterThan(0);
    for (const conflict of result.result.conflicts) {
      expect(conflict.note).toBeTruthy();
      expect(conflict.required).toBeTruthy();
    }
  });
});

describe('注册表参与重定向（约束 C-2）', () => {
  it('通过注册表调用默认求解器与直接调用等价', () => {
    const registry = createDefaultRegistry();
    const { storyboard, step } = solvedStep(IntentKind.Emphasize, 'hall@1/column_c__01');
    const viaRegistry = redirect(storyboard, step.id, singleTarget('hall@1/columnbase_e__01'), registry.get());
    const direct = redirect(storyboard, step.id, singleTarget('hall@1/columnbase_e__01'), new SamplingSolver());
    expect(JSON.stringify(viaRegistry.result.camera)).toBe(JSON.stringify(direct.result.camera));
  });
});
