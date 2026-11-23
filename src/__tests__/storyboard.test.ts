/**
 * M6 分镜完整性 的单元测试
 *
 * **本文件里最关键的一组断言围绕 `SolveState.Stale`**（§5.6）：
 * 换目标之后，系统必须「知道」自己处于「意图已更新、实现待重算」的状态。
 * 这是「意图可迁移」在数据层的证据，也是与 Navisworks 静态视点的分水岭。
 */
import { describe, it, expect } from 'vitest';
import {
  validateStoryboard,
  addStep,
  removeStep,
  duplicateStep,
  moveStep,
  retargetStep,
  updateIntent,
  applySolveResult,
  markStale,
  checkModelCompatibility,
  storyboardStats,
  cloneTarget,
  findStep,
} from '../domain/storyboard/storyboard.ts';
import { createStep, createStoryboard } from '../domain/types/storyboard.ts';
import { IntentKind, defaultPredicatesFor } from '../domain/types/intent.ts';
import type { VisualIntent } from '../domain/types/intent.ts';
import type { Storyboard } from '../domain/types/storyboard.ts';
import { singleTarget, relationTarget, poseLookingNorth, semantics } from './fixtures.ts';
import { resetIdCounter } from '../core/id.ts';

function intent(kind: IntentKind = IntentKind.Emphasize): VisualIntent {
  return {
    id: 'intent_1',
    kind,
    predicates: defaultPredicatesFor(kind),
    provenance: { source: 'demo', confidence: 0.8, rationale: '测试用', confirmedByUser: false },
  };
}

function buildBoard(): Storyboard {
  resetIdCounter();
  let board = createStoryboard('测试分镜');
  board = addStep(board, createStep(singleTarget('hall@1/column_c__01', 'column'), '第一步'));
  board = addStep(board, createStep(singleTarget('hall@1/dougong_se__01', 'dougong'), '第二步'));
  return board;
}

describe('校验 (FR-10 保存前检查)', () => {
  it('空分镜给出警告而不是错误（允许保存草稿）', () => {
    const result = validateStoryboard(createStoryboard());
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('步骤 ID 重复是阻断性错误', () => {
    const board = buildBoard();
    const broken: Storyboard = { ...board, steps: [...board.steps, { ...board.steps[0] }] };
    const result = validateStoryboard(broken);
    expect(result.errors.some((e) => e.includes('ID 重复'))).toBe(true);
  });

  it('标记为已求解但没有相机 → 阻断性错误（状态自相矛盾）', () => {
    const board = buildBoard();
    const broken: Storyboard = {
      ...board,
      steps: board.steps.map((s) => ({ ...s, solve: 'solved' as const, camera: null })),
    };
    expect(validateStoryboard(broken).errors.some((e) => e.includes('自相矛盾'))).toBe(true);
  });

  it('时长为 0 是阻断性错误', () => {
    const board = buildBoard();
    const broken: Storyboard = {
      ...board,
      steps: board.steps.map((s) => ({ ...s, durationMs: 0 })),
    };
    expect(validateStoryboard(broken).errors.some((e) => e.includes('时长'))).toBe(true);
  });

  it('没有意图的步骤给出警告（重定向时无法保持意图）', () => {
    const board = buildBoard();
    expect(validateStoryboard(board).warnings.some((w) => w.includes('意图'))).toBe(true);
  });

  it('关系两端指向同一构件是阻断性错误', () => {
    const board = buildBoard();
    const broken: Storyboard = {
      ...board,
      steps: board.steps.map((s) => ({ ...s, target: relationTarget('a', 'a') })),
    };
    expect(validateStoryboard(broken).errors.some((e) => e.includes('同一个构件'))).toBe(true);
  });

  it('REVEAL_RELATION 配单目标是警告（多半会求解失败）', () => {
    const board = buildBoard();
    const warned: Storyboard = {
      ...board,
      steps: board.steps.map((s) => ({ ...s, intent: intent(IntentKind.RevealRelation) })),
    };
    expect(validateStoryboard(warned).warnings.some((w) => w.includes('单个构件'))).toBe(true);
  });

  it('引用了当前模型中不存在的构件时给出警告（支撑 C-3）', () => {
    const board = buildBoard();
    const available = new Set(['hall@1/column_c__01']); // 第二个步骤的构件不在
    const result = validateStoryboard(board, available);
    expect(result.warnings.some((w) => w.includes('不存在'))).toBe(true);
  });
});

describe('增删复制重排 (FR-8)', () => {
  it('追加步骤放在末尾', () => {
    const board = addStep(buildBoard(), createStep(singleTarget('c'), '第三步'));
    expect(board.steps.length).toBe(3);
    expect(board.steps[2].title).toBe('第三步');
  });

  it('在指定位置插入', () => {
    const board = addStep(buildBoard(), createStep(singleTarget('c'), '插队'), 0);
    expect(board.steps[0].title).toBe('插队');
  });

  it('删除步骤', () => {
    const board = buildBoard();
    const after = removeStep(board, board.steps[0].id);
    expect(after.steps.length).toBe(1);
    expect(after.steps[0].title).toBe('第二步');
  });

  it('★ 复制步骤会生成新的 ID（共用 ID 会让删除连带删掉两个）', () => {
    const board = buildBoard();
    const after = duplicateStep(board, board.steps[0].id);
    expect(after.steps.length).toBe(3);
    expect(after.steps[0].id).not.toBe(after.steps[1].id);
    expect(after.steps[1].title).toContain('副本');
  });

  it('★ 复制步骤时 target 与 intent 是深拷贝，改副本不影响原件', () => {
    const board = buildBoard();
    const withIntent: Storyboard = {
      ...board,
      steps: board.steps.map((s) => ({ ...s, intent: intent() })),
    };
    const after = duplicateStep(withIntent, withIntent.steps[0].id);
    const copyTarget = after.steps[1].target;
    if (copyTarget.form === 'single') copyTarget.component.id = 'hall@1/被改过';
    after.steps[1].intent!.predicates[0].test = { op: '==', value: 0 };
    const originalTarget = withIntent.steps[0].target;
    expect(originalTarget.form === 'single' && originalTarget.component.id).toBe('hall@1/column_c__01');
    expect(withIntent.steps[0].intent!.predicates[0].test).toEqual({ op: '>=', value: 0.12 });
  });

  it('重排步骤', () => {
    const board = buildBoard();
    const after = moveStep(board, 0, 1);
    expect(after.steps[0].title).toBe('第二步');
    expect(after.steps[1].title).toBe('第一步');
  });

  it('越界的重排索引被夹紧，不抛异常', () => {
    const board = buildBoard();
    expect(() => moveStep(board, 0, 99)).not.toThrow();
    expect(moveStep(board, 99, 0)).toBe(board);
  });
});

describe('★ SolveState.Stale —— 意图可迁移在数据层的证据 (§5.6)', () => {
  it('换目标后：意图一字不改，状态变 stale，旧机位保留作种子', () => {
    const board = buildBoard();
    const pose = poseLookingNorth(5, 2);
    const withSolved: Storyboard = {
      ...board,
      steps: board.steps.map((s, i) =>
        i === 0 ? { ...s, intent: intent(), camera: pose, solve: 'solved' as const } : s,
      ),
    };

    const after = retargetStep(withSolved, withSolved.steps[0].id, singleTarget('hall@1/dougong_nw__01', 'dougong'));
    const step = findStep(after, withSolved.steps[0].id)!;

    // ① 意图原封不动 —— 「意图保持」的字面含义（§6.2 立场 1）
    expect(step.intent).toEqual(withSolved.steps[0].intent);
    // ② 状态立刻反映「实现已失效」
    expect(step.solve).toBe('stale');
    // ③ 旧机位保留 —— 它是重解时的种子
    expect(step.camera).toEqual(pose);
    // ④ 目标确实换了
    expect(step.target.form === 'single' && step.target.component.id).toBe('hall@1/dougong_nw__01');
    // ⑤ 有可读的说明交给 UI
    expect(step.solveNote).toBeTruthy();
  });

  it('未求解的步骤改目标后仍是「未求解」，不能无中生有变成「待重算」', () => {
    const board = buildBoard();
    // 新步骤默认 solve: 'none'
    const after = retargetStep(board, board.steps[0].id, singleTarget('hall@1/other'));
    expect(findStep(after, board.steps[0].id)!.solve).toBe('none');
  });

  it('markStale 的状态迁移表', () => {
    expect(markStale('none')).toBe('none');
    expect(markStale('solved')).toBe('stale');
    expect(markStale('stale')).toBe('stale');
    expect(markStale('failed')).toBe('stale');
  });

  it('改意图同样标 stale', () => {
    const board = buildBoard();
    const solved: Storyboard = {
      ...board,
      steps: board.steps.map((s) => ({ ...s, camera: poseLookingNorth(), solve: 'solved' as const })),
    };
    const after = updateIntent(solved, solved.steps[0].id, intent(IntentKind.ShowOverview));
    expect(findStep(after, solved.steps[0].id)!.solve).toBe('stale');
  });
});

describe('求解结果的写入与拒绝 (§6.2 步骤 ⑥ 与立场 3)', () => {
  it('成功时写入机位、特效与状态', () => {
    const board = buildBoard();
    const pose = poseLookingNorth(4, 1);
    const after = applySolveResult(board, board.steps[0].id, {
      camera: pose,
      effects: { highlight: ['x'], transparent: [], hidden: [] },
      note: '已求解，保真度 92%',
      ok: true,
    });
    const step = findStep(after, board.steps[0].id)!;
    expect(step.solve).toBe('solved');
    expect(step.camera).toEqual(pose);
    expect(step.effects.highlight).toEqual(['x']);
    expect(step.solveNote).toContain('92%');
  });

  it('★ 失败时只改状态，不写入劣质结果（不覆盖已有相机）', () => {
    const board = buildBoard();
    const goodPose = poseLookingNorth(3, 1);
    const solved: Storyboard = {
      ...board,
      steps: board.steps.map((s) => ({ ...s, camera: goodPose, solve: 'solved' as const })),
    };
    const after = applySolveResult(solved, solved.steps[0].id, {
      camera: null,
      effects: { highlight: [], transparent: [], hidden: [] },
      note: '重解失败：2 条约束无法满足',
      ok: false,
    });
    const step = findStep(after, solved.steps[0].id)!;
    expect(step.solve).toBe('failed');
    // 旧机位仍在 —— 我们宁可保留「已知能用的旧结果」，也不写入一个劣质的新结果
    expect(step.camera).toEqual(goodPose);
    expect(step.solveNote).toContain('失败');
  });

  it('ok 为真但 camera 为 null 时按失败处理（防御性）', () => {
    const board = buildBoard();
    const after = applySolveResult(board, board.steps[0].id, {
      camera: null,
      effects: { highlight: [], transparent: [], hidden: [] },
      note: '异常',
      ok: true,
    });
    expect(findStep(after, board.steps[0].id)!.solve).toBe('failed');
  });
});

describe('模型兼容性检查 (支撑 C-3)', () => {
  const modelRef = { name: '厅堂', componentCount: 86, modelPrefix: 'demohall' };

  it('前缀与构件数都一致 → 兼容', () => {
    const board: Storyboard = { ...buildBoard(), modelRef };
    expect(checkModelCompatibility(board, { prefix: 'demohall', componentCount: 86 }).compatible).toBe(true);
  });

  it('前缀不同 → 不兼容，理由里点明前缀差异', () => {
    const board: Storyboard = { ...buildBoard(), modelRef };
    const result = checkModelCompatibility(board, { prefix: 'other', componentCount: 86 });
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('demohall');
    expect(result.reason).toContain('other');
  });

  it('构件数不同 → 不兼容（模型内容已变化）', () => {
    const board: Storyboard = { ...buildBoard(), modelRef };
    const result = checkModelCompatibility(board, { prefix: 'demohall', componentCount: 90 });
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain('86');
  });

  it('未记录来源模型时判为兼容但给出说明', () => {
    const result = checkModelCompatibility(buildBoard(), { prefix: 'demohall', componentCount: 86 });
    expect(result.compatible).toBe(true);
    expect(result.reason).toBeTruthy();
  });
});

describe('统计与克隆', () => {
  it('storyboardStats 汇总各状态与总时长', () => {
    const board = buildBoard();
    const mixed: Storyboard = {
      ...board,
      steps: [
        { ...board.steps[0], solve: 'solved' as const, camera: poseLookingNorth(), durationMs: 3000 },
        { ...board.steps[1], solve: 'failed' as const, durationMs: 2000 },
      ],
    };
    const stats = storyboardStats(mixed);
    expect(stats.total).toBe(2);
    expect(stats.solved).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.totalDurationMs).toBe(5000);
  });

  it('cloneTarget 是深拷贝', () => {
    const original = relationTarget('a', 'b');
    const copy = cloneTarget(original);
    if (copy.form === 'relation') copy.from.id = '改了';
    expect(original.form === 'relation' && original.from.id).toBe('a');
  });

  it('语义对象被正确推导（kind/part/label 三项齐全）', () => {
    const s = semantics('dougong', 'se');
    expect(s.kind).toBe('dougong');
    expect(s.part).toBe('se');
    expect(s.label).toBeTruthy();
  });
});
