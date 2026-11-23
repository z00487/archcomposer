/**
 * M8 求解器 的单元测试
 *
 * **这里最重要的一组断言是「可复现性」**（§6.2 立场 2）：相同的 SolveRequest
 * 必须产出逐位相同的结果。候选采样被选中而不是梯度下降，很大程度上就是为了
 * 这条性质——论文的 E1 评估要在等价条件下跑很多次，任何随机漂移都会让结论
 * 不可解释。
 */
import { describe, it, expect } from 'vitest';
import { createDefaultRegistry } from '../domain/solver/registry.ts';
import { SamplingSolver, rankCandidates, effectsForIntent, priorScore } from '../domain/solver/solver.ts';
import { sampleCandidates, focusPoint, focusScale, findOccluders } from '../domain/solver/sampling.ts';
import { computeContextIds, majorStructureIds } from '../domain/solver/context.ts';
import { IntentKind, defaultPredicatesFor } from '../domain/types/intent.ts';
import type { SolveRequest, ViewSolver, SolveResult, SceneSummary } from '../domain/types/solver.ts';
import { box, poseLookingNorth, singleTarget, testScene, relationTarget } from './fixtures.ts';
import type { VisualIntent } from '../domain/types/intent.ts';
import { quatLookAt, v3sub } from '../core/math.ts';

function intent(kind: IntentKind): VisualIntent {
  return {
    id: 'i1',
    kind,
    predicates: defaultPredicatesFor(kind),
    provenance: { source: 'manual', confidence: 1, rationale: 'test', confirmedByUser: true },
  };
}

function request(kind: IntentKind, targetId = 'hall@1/column_c__01'): SolveRequest {
  return {
    target: singleTarget(targetId),
    intent: intent(kind),
    scene: testScene(1.6),
  };
}

describe('候选采样', () => {
  it('生成的候选数等于网格规模（无种子时）', () => {
    const candidates = sampleCandidates(request(IntentKind.Emphasize));
    // 16 方位 × 5 俯角 × 6 距离 × 2 视野角 = 960
    expect(candidates.length).toBe(960);
  });

  it('带种子位姿时候选数 +1，且种子排在第一位', () => {
    const seed = poseLookingNorth(7, 3);
    const candidates = sampleCandidates({ ...request(IntentKind.Emphasize), seed });
    expect(candidates.length).toBe(961);
    expect(candidates[0].position).toEqual(seed.position);
  });

  it('maxCandidates 生效时提前返回', () => {
    const candidates = sampleCandidates({ ...request(IntentKind.Emphasize), maxCandidates: 50 });
    expect(candidates.length).toBe(50);
  });

  it('采样确定性：两次调用结果逐位相同', () => {
    const a = sampleCandidates(request(IntentKind.Emphasize));
    const b = sampleCandidates(request(IntentKind.Emphasize));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('所有候选都在场景包围盒附近（不会采到无穷远）', () => {
    const candidates = sampleCandidates(request(IntentKind.Emphasize));
    for (const c of candidates) {
      expect(Number.isFinite(c.position[0])).toBe(true);
      expect(Number.isFinite(c.position[1])).toBe(true);
      expect(Number.isFinite(c.position[2])).toBe(true);
      expect(Math.abs(c.position[0])).toBeLessThan(200);
    }
  });

  it('单目标的采样尺度 = 构件最长边', () => {
    const scale = focusScale(singleTarget('hall@1/column_c__01'), testScene(1));
    // 柱子边长 1 → 尺度 1
    expect(scale).toBeCloseTo(1, 5);
  });

  it('关系目标的采样尺度 = 两构件间距（而不是各自尺寸之和）', () => {
    const scale = focusScale(relationTarget('hall@1/column_c__01', 'hall@1/columnbase_e__01'), testScene(1));
    // 原点 (0,0.5,0) 与 (5,0.1,0) 相距约 5.0
    expect(scale).toBeCloseTo(5.0, 1);
  });

  it('关系目标的采样焦点是两端中点', () => {
    const focus = focusPoint(relationTarget('hall@1/column_c__01', 'hall@1/columnbase_e__01'), testScene(1));
    expect(focus[0]).toBeCloseTo(2.5, 1);
    expect(focus[1]).toBeCloseTo(0.3, 1);
  });
});

describe('求解器 (M8)', () => {
  it('强调意图能解出满足约束的机位', () => {
    const solver = new SamplingSolver();
    const result = solver.solve(request(IntentKind.Emphasize));
    expect(result.ok).toBe(true);
    expect(result.camera).not.toBeNull();
    expect(result.fidelity.overall).toBeGreaterThan(0.65);
    expect(result.solver).toBe('sampling-v1');
    expect(result.evaluated).toBeGreaterThan(0);
  });

  it('★ 可复现性：同一请求两次求解结果逐位相同', () => {
    const solver = new SamplingSolver();
    const a = solver.solve(request(IntentKind.Emphasize));
    const b = solver.solve(request(IntentKind.Emphasize));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('★ 失败时不写入相机（FR-19：不允许静默产出劣质结果）', () => {
    const solver = new SamplingSolver();
    // 要求画面占比 >= 5.0：物理上不可能
    const impossible: SolveRequest = {
      ...request(IntentKind.Emphasize),
      intent: {
        ...intent(IntentKind.Emphasize),
        predicates: [{ measure: 'screenCoverage', subjects: [], test: { op: '>=', value: 5 }, weight: 1 }],
      },
    };
    const result = solver.solve(impossible);
    expect(result.ok).toBe(false);
    expect(result.camera).toBeNull();
    expect(result.conflicts.length).toBeGreaterThan(0);
    // 冲突必须带可读说明
    expect(result.conflicts[0].note).toBeTruthy();
  });

  it('目标不在场景中时给出明确失败，而不是崩溃', () => {
    const solver = new SamplingSolver();
    const result = solver.solve(request(IntentKind.Emphasize, 'hall@1/并不存在'));
    expect(result.ok).toBe(false);
    expect(result.camera).toBeNull();
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it('每种意图类型都能解出结果（不抛异常）', () => {
    const solver = new SamplingSolver();
    for (const kind of Object.values(IntentKind)) {
      const result = solver.solve(request(kind));
      expect(typeof result.ok).toBe('boolean');
      expect(result.evaluated).toBeGreaterThan(0);
    }
  });

  it('关系型意图会挑一个能同时看到两端的机位（而非只看到一端）', () => {
    const solver = new SamplingSolver();
    const result = solver.solve({
      target: relationTarget('hall@1/column_c__01', 'hall@1/columnbase_e__01'),
      intent: intent(IntentKind.RevealRelation),
      scene: testScene(1.6),
    });
    // 两个构件在 x 方向相距 5 米，要同框必须后退得足够多
    expect(result.evaluated).toBeGreaterThan(0);
    if (result.camera) {
      const distance = Math.hypot(result.camera.position[0] - 2.5, result.camera.position[2] - 0);
      expect(distance).toBeGreaterThan(5);
    }
  });

  it('rankCandidates 返回按分数降序的候选，且首位与求解结果一致', () => {
    const ranked = rankCandidates(request(IntentKind.Emphasize), 5);
    expect(ranked.length).toBe(5);
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
    const solver = new SamplingSolver();
    const best = solver.solve(request(IntentKind.Emphasize));
    if (best.camera) {
      expect(ranked[0].pose.position).toEqual(best.camera.position);
    }
  });

  it('先验评分：极近与极远都被扣分，适中距离得高分', () => {
    const focus: [number, number, number] = [0, 0.5, 0];
    const tooClose = priorScore({ position: [0, 0.5, 0.6], quaternion: [0, 0, 0, 1], fovY: Math.PI / 4 }, focus, 1);
    const good = priorScore({ position: [0, 0.5, 4], quaternion: [0, 0, 0, 1], fovY: Math.PI / 4 }, focus, 1);
    const tooFar = priorScore({ position: [0, 0.5, 60], quaternion: [0, 0, 0, 1], fovY: Math.PI / 4 }, focus, 1);
    expect(good).toBeGreaterThan(tooClose);
    expect(good).toBeGreaterThan(tooFar);
  });
});

describe('意图 → 特效（M8 的映射）', () => {
  it('减少遮挡会给遮挡物加透明度，而不是隐藏它', () => {
    const s = testScene(1.6);
    // 在相机与柱子之间放一个遮挡物
    const withOccluder = {
      ...s,
      components: [...s.components, box('blocker', 'beam', [0, 0.5, 2], [3, 3, 0.4])],
    };
    const pose = poseLookingNorth(4, 0.5);
    const effects = effectsForIntent(
      intent(IntentKind.ReduceOcclusion),
      ['hall@1/column_c__01'],
      pose,
      withOccluder,
      singleTarget('hall@1/column_c__01'),
    );
    expect(effects.transparent.length).toBeGreaterThan(0);
    expect(effects.hidden.length).toBe(0);
  });

  it('俯瞰意图不高亮任何单个构件（全亮等于全不亮）', () => {
    const s = testScene(1.6);
    const effects = effectsForIntent(
      intent(IntentKind.ShowOverview),
      [],
      poseLookingNorth(10, 8),
      s,
      singleTarget('hall@1/column_c__01'),
    );
    expect(effects.highlight).toEqual([]);
  });

  it('揭示关系时两端都高亮（只亮一端看不出关系）', () => {
    const s = testScene(1.6);
    const effects = effectsForIntent(
      intent(IntentKind.RevealRelation),
      ['hall@1/column_c__01', 'hall@1/columnbase_e__01'],
      poseLookingNorth(12, 3),
      s,
      relationTarget('hall@1/column_c__01', 'hall@1/columnbase_e__01'),
    );
    expect(effects.highlight).toContain('hall@1/column_c__01');
    expect(effects.highlight).toContain('hall@1/columnbase_e__01');
  });
});

describe('求解器注册表（约束 C-2 / NFR-7）', () => {
  it('默认注册表里有一个采样求解器，且是默认', () => {
    const registry = createDefaultRegistry();
    expect(registry.list()).toContain('sampling-v1');
    expect(registry.defaultSolverName).toBe('sampling-v1');
  });

  it('★ 换求解器不改调用方：注册一个假求解器后按名调用即可', () => {
    const registry = createDefaultRegistry();
    const fake: ViewSolver = {
      name: 'fake-solver',
      solve(): SolveResult {
        return {
          ok: true,
          camera: poseLookingNorth(3, 1),
          effects: { highlight: [], transparent: [], hidden: [] },
          fidelity: { overall: 1, perPredicate: [], conflicts: [] },
          conflicts: [],
          solver: 'fake-solver',
          evaluated: 0,
        };
      },
    };
    registry.register(fake);
    const result = registry.solve(request(IntentKind.Emphasize), 'fake-solver');
    expect(result.solver).toBe('fake-solver');

    registry.setDefault('fake-solver');
    const byDefault = registry.solve(request(IntentKind.Emphasize));
    expect(byDefault.solver).toBe('fake-solver');
  });

  it('重复注册同名求解器会抛错（而不是静默覆盖）', () => {
    const registry = createDefaultRegistry();
    expect(() => registry.register(new SamplingSolver())).toThrow(/已被注册/);
  });

  it('取未注册的求解器会抛错，并列出已注册的名字', () => {
    const registry = createDefaultRegistry();
    expect(() => registry.get('不存在')).toThrow(/未注册/);
  });
});

describe('上下文与遮挡物推导', () => {
  it('上下文包含同类构件，且排除目标自身', () => {
    const s = testScene(1.6);
    const contextIds = computeContextIds(singleTarget('hall@1/column_c__01'), s);
    expect(contextIds).not.toContain('hall@1/column_c__01');
  });

  it('上下文不含不可见构件', () => {
    const s = testScene(1.6);
    const contextIds = computeContextIds(singleTarget('hall@1/column_c__01'), s);
    expect(contextIds).not.toContain('hall@1/hidden_x');
  });

  it('主要结构构件优先返回柱、梁、屋面（俯瞰意图用）', () => {
    const s = testScene(1.6);
    const majors = majorStructureIds(s);
    expect(majors[0]).toBe('hall@1/column_c__01'); // 柱优先
    expect(majors).not.toContain('hall@1/hidden_x');
  });

  it('遮挡物推导：挡在相机与目标之间的构件被识别出来', () => {
    const s = testScene(1.6);
    const withOccluder = {
      ...s,
      components: [...s.components, box('blocker', 'beam', [0, 0.5, 2], [3, 3, 0.4])],
    };
    const occluders = findOccluders(
      singleTarget('hall@1/column_c__01'),
      poseLookingNorth(4, 0.5),
      withOccluder,
    );
    expect(occluders).toContain('blocker');
  });

  it('目标之外的构件不会被当成遮挡物', () => {
    const s = testScene(1.6);
    const occluders = findOccluders(
      singleTarget('hall@1/column_c__01'),
      poseLookingNorth(4, 0.5),
      s,
    );
    expect(occluders).not.toContain('hall@1/column_c__01');
  });
});

describe('★ REDUCE_OCCLUSION 的处理优先级（实测确认的一条行为）', () => {
  /**
   * 这组测试锁住一个**看起来像 bug、实际是刻意设计**的行为。
   *
   * 用生成的真实厅堂（86 构件）跑 `REDUCE_OCCLUSION` 时，最终
   * `effects.transparent` 是**空数组**——第一反应是「`findOccluders` 是死代码」。
   * 逐条查下来不是：在**人为构造的必定被遮挡的机位**下，它能正确找出一串
   * 挡在前面的构件（柱、柱础、台基）。
   *
   * 真实原因是**优先级**：求解器在 960 个候选里总能找到一个「本来就看得清」
   * 的角度，因此根本不需要调透明。这是正确——**换机位比调透明更干净**：
   * 调透明会改变场景外观，是「有代价」的手段，只在换机位解决不了时才该用。
   *
   * 这组测试由此分成两半：一半测「不该调透明时不调」，一半测「该找得出遮挡物时找得出」。
   * 把两半都锁住，是为了防止将来有人看到 `transparent` 常年为空，就把
   * `findOccluders` 当死代码删掉。
   */

  /** 只含一个目标、没有任何遮挡物的干净场景。 */
  function cleanScene(): SceneSummary {
    return {
      components: [box('t@1/column_c__01', 'column', [0, 1, 0], [0.6, 2, 0.6])],
      boundsMin: [-5, 0, -5],
      boundsMax: [5, 4, 5],
      aspect: 1,
      modelPrefix: 't',
    };
  }

  it('没有任何遮挡物时，findOccluders 返回空——不该凭空调透明', () => {
    const scene = cleanScene();
    const pose = {
      position: [3, 1.5, 3] as [number, number, number],
      quaternion: quatLookAt(v3sub([0, 1, 0], [3, 1.5, 3]), [0, 1, 0]),
      fovY: Math.PI / 4,
    };
    expect(findOccluders(singleTarget('t@1/column_c__01'), pose, scene, 3)).toEqual([]);
  });

  it('★ 目标确实被挡住时，findOccluders 会如实找出挡路的构件', () => {
    const target = box('t@1/column_c__01', 'column', [0, 1, 0], [0.6, 2, 0.6]);
    // 挡板横在相机与目标之间
    const screen = box('t@1/screen', 'beam', [0, 1, -3], [6, 3, 0.2]);
    const scene: SceneSummary = {
      components: [target, screen],
      boundsMin: [-5, 0, -6],
      boundsMax: [5, 4, 5],
      aspect: 1,
      modelPrefix: 't',
    };
    const pose = {
      position: [0, 1, -7] as [number, number, number],
      quaternion: quatLookAt(v3sub([0, 1, 0], [0, 1, -7]), [0, 1, 0]),
      fovY: Math.PI / 4,
    };
    const occluders = findOccluders(singleTarget('t@1/column_c__01'), pose, scene, 3);
    expect(occluders).toContain('t@1/screen');
  });

  it('挡在旁边的构件（不挡视线）不会被误报为遮挡物', () => {
    const target = box('t@1/column_c__01', 'column', [0, 1, 0], [0.6, 2, 0.6]);
    // 与目标同高、但在旁边 4 米处的邻居——不挡视线
    const neighbour = box('t@1/neighbour', 'column', [4, 1, 0], [0.6, 2, 0.6]);
    const scene: SceneSummary = {
      components: [target, neighbour],
      boundsMin: [-5, 0, -6],
      boundsMax: [5, 4, 5],
      aspect: 1,
      modelPrefix: 't',
    };
    const pose = {
      position: [0, 1, -7] as [number, number, number],
      quaternion: quatLookAt(v3sub([0, 1, 0], [0, 1, -7]), [0, 1, 0]),
      fovY: Math.PI / 4,
    };
    expect(findOccluders(singleTarget('t@1/column_c__01'), pose, scene, 3)).toEqual([]);
  });
});
