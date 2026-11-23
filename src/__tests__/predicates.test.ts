/**
 * M7 谓词求值 / M9 保真度 的单元测试（概要设计 §10.1 的 A3：迁移到 vitest）
 *
 * **这一组测试是「意图可脱离浏览器度量」这条主张的证据。** 它们不启动浏览器、
 * 不创建 WebGL 上下文、不 import three —— 这正是约束 C-1 要买到的东西。
 */
import { describe, it, expect } from 'vitest';
import {
  measureScreenCoverage,
  measureVisible,
  measureVisibleFraction,
  measureElevationRatio,
  measureScreenDistance,
  measureContextVisible,
  scoreValue,
  evaluatePredicates,
} from '../domain/intent/predicates.ts';
import { aggregate, evaluateFidelity, evaluateRedirectionFidelity } from '../domain/fidelity/fidelity.ts';
import { box, poseLookingNorth, singleTarget, testScene, relationTarget } from './fixtures.ts';
import type { SceneSummary } from '../domain/types/solver.ts';
import type { VisualIntent } from '../domain/types/intent.ts';
import { IntentKind, defaultPredicatesFor, predicate } from '../domain/types/intent.ts';
import { testScene as scene } from './fixtures.ts';

function intent(kind: IntentKind, extra = [] as ReturnType<typeof predicate.visible>[]): VisualIntent {
  return {
    id: 'i1',
    kind,
    predicates: [...defaultPredicatesFor(kind), ...extra],
    provenance: { source: 'manual', confidence: 1, rationale: 'test', confirmedByUser: true },
  };
}

describe('几何量计算 (M7)', () => {
  it('正对着构件看时，构件在画面中占一定比例', () => {
    const s = testScene(1);
    const column = s.components[0]; // 边长 1，位于原点上方
    const pose = poseLookingNorth(4, 0.5); // 距离 4 米正对
    const coverage = measureScreenCoverage(column, pose, s);

    // 31.8° 半角下 4 米处，画面高度 ≈ 2*4*tan(31.8°) ≈ 4.96 米
    // 柱子高 1 米 → 约占画面高度 20%；宽同理 → 面积占比 ≈ 4%
    expect(coverage).toBeGreaterThan(0.02);
    expect(coverage).toBeLessThan(0.12);
  });

  it('拉近相机时画面占比单调上升', () => {
    const s = testScene(1);
    const column = s.components[0];
    const far = measureScreenCoverage(column, poseLookingNorth(8, 0.5), s);
    const near = measureScreenCoverage(column, poseLookingNorth(2, 0.5), s);
    expect(near).toBeGreaterThan(far * 2);
  });

  it('相机背后的构件占比为 0', () => {
    const s = testScene(1);
    const column = s.components[0]; // 位于原点上方
    // 站在 +Z 侧 6 米处、朝 **+Z** 看（背对原点）。
    // 绕 Y 转 180° 的四元数是 (0, 1, 0, 0)：相机局部 -Z 被转到世界 +Z 方向。
    const pose = {
      position: [0, 0.5, 6] as [number, number, number],
      quaternion: [0, 1, 0, 0] as [number, number, number, number],
      fovY: Math.PI / 4,
    };
    expect(measureScreenCoverage(column, pose, s)).toBe(0);
    expect(measureVisible(column, pose, s)).toBe(0);
  });

  it('视锥内的构件 measureVisible 为 1，视锥外的为 0', () => {
    const s = testScene(1);
    const column = s.components[0];
    const farAway = box('t', 'column', [400, 0, 400], [1, 1, 1]);
    expect(measureVisible(column, poseLookingNorth(4, 0.5), s)).toBe(1);
    expect(measureVisible(farAway, poseLookingNorth(4, 0.5), s)).toBe(0);
  });

  it('俯角高度比：相机在上方为正，同高为 0，下方为负', () => {
    const s = testScene(1);
    const column = s.components[0]; // 中心 y = 0.5
    const above = measureElevationRatio(column, poseLookingNorth(4, 10));
    const level = measureElevationRatio(column, poseLookingNorth(4, 0.5));
    const below = measureElevationRatio(column, poseLookingNorth(4, -10));
    expect(above).toBeGreaterThan(0.5);
    expect(Math.abs(level)).toBeLessThan(0.01);
    expect(below).toBeLessThan(-0.5);
  });

  it('两个构件的画面距离：正对时居中的两个构件距离较小', () => {
    const s = testScene(1);
    const a = box('a', 'dougong', [0, 0.5, 0], [1, 1, 1]);
    const b = box('b', 'purlin', [1.5, 0.5, 0], [1, 1, 1]);
    const pose = poseLookingNorth(6, 0.5);
    const distance = measureScreenDistance(a, b, pose, s);
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(0.9);
  });

  it('被挡住时可见比例下降（遮挡物在相机与目标之间）', () => {
    const s = testScene(1);
    const column = s.components[0];
    const pose = poseLookingNorth(4, 0.5);

    const withoutOccluder = measureVisibleFraction(column, pose, s);
    const sceneWithOccluder = {
      ...s,
      components: [
        ...s.components,
        box('occluder', 'beam', [0, 0.5, 2], [3, 3, 0.4]),
      ],
    };
    const withOccluder = measureVisibleFraction(column, pose, sceneWithOccluder);

    expect(withoutOccluder).toBe(1);
    expect(withOccluder).toBeLessThan(withoutOccluder);
  });

  it('上下文可见度：全部上下文可见时为 1', () => {
    const s = testScene(1);
    const pose = poseLookingNorth(6, 0.5);
    const contextIds = ['hall@1/column_c__01'];
    const ratio = measureContextVisible(contextIds, pose, s, ['hall@1/columnbase_e__01']);
    expect(ratio).toBe(1);
  });
});

describe('★ 回归：AABB 邻接不应被误判为遮挡（实测踩出来的 bug）', () => {
  /**
   * 这个 bug 的发现过程值得记录下来：
   *
   * 在生成的 86 构件厅堂上跑「换一根柱子」的重定向，`EMPHASIZE` 全部失败，
   * 报告说柱子「可见度仅 11%」。逐条打印 27 条采样射线后发现：被判为遮挡的
   * 全是**包围盒包含了采样点自身**的邻接构件——柱子的底面角点落在柱础里
   * （y=0 正好是接触面），顶面角点落在屋面里。**AABB 是包围盒，不是实体**，
   * 构件层叠时它们的包围盒必然重叠。
   *
   * 下面两个用例从正反两面锁住修法。
   */
  it('紧贴在目标下方、包围盒与目标接触的构件，不算遮挡', () => {
    const column = box('col', 'column', [0, 2, 0], [0.4, 4, 0.4]); // y 0~4
    const base = box('base', 'columnbase', [0, 0.08, 0], [0.6, 0.16, 0.6]); // y 0~0.16，与柱底面接触
    const s: SceneSummary = {
      components: [column, base],
      boundsMin: [-1, 0, -1],
      boundsMax: [1, 4, 1],
      aspect: 1,
      modelPrefix: 't',
    };
    // 相机在柱子的正前方，柱础在柱子**下方**且与它相接
    const pose = { position: [0, 2, 8] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], fovY: Math.PI / 4 };
    expect(measureVisibleFraction(column, pose, s)).toBe(1);
  });

  it('但真正挡在相机与目标之间的构件，仍然被判为遮挡', () => {
    const column = box('col', 'column', [0, 2, 0], [0.4, 4, 0.4]);
    const blocker = box('blocker', 'beam', [0, 2, 3], [2, 4, 0.3]); // 相机在 z=8，目标在 z=0
    const s: SceneSummary = {
      components: [column, blocker],
      boundsMin: [-1, 0, -1],
      boundsMax: [1, 4, 9],
      aspect: 1,
      modelPrefix: 't',
    };
    const pose = { position: [0, 2, 8] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], fovY: Math.PI / 4 };
    // 挡板完全遮住视线 → 可见比例应当很低
    expect(measureVisibleFraction(column, pose, s)).toBeLessThan(0.2);
  });

  it('目标被「同高的邻居」贴着（并列关系）也不算遮挡', () => {
    const a = box('a', 'beam', [0, 2, 0], [2, 0.4, 0.4]);
    const b = box('b', 'beam', [2.0, 2, 0], [2, 0.4, 0.4]); // 与 a 在 x 方向面接触
    const s: SceneSummary = {
      components: [a, b],
      boundsMin: [-2, 0, -2],
      boundsMax: [4, 4, 2],
      aspect: 1,
      modelPrefix: 't',
    };
    const pose = { position: [1, 2, 10] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], fovY: Math.PI / 4 };
    expect(measureVisibleFraction(a, pose, s)).toBe(1);
  });
});

describe('谓词满足度折算', () => {
  it('>= 比较符：达到阈值为 1，超出阈值也为 1，不足时按比例折扣', () => {
    expect(scoreValue(0.2, { op: '>=', value: 0.1 })).toBe(1);
    expect(scoreValue(0.05, { op: '>=', value: 0.1 })).toBeCloseTo(0.5, 5);
    expect(scoreValue(0, { op: '>=', value: 0.1 })).toBe(0);
  });

  it('== 布尔量退化为 0 / 1', () => {
    expect(scoreValue(1, { op: '==', value: 1 })).toBe(1);
    expect(scoreValue(0, { op: '==', value: 1 })).toBe(0);
  });

  it('in 区间：区间内为 1，区间外按跨度折扣', () => {
    expect(scoreValue(0.5, { op: 'in', value: [0.2, 0.8] })).toBe(1);
    expect(scoreValue(0.1, { op: 'in', value: [0.2, 0.8] })).toBeCloseTo(1 - 0.1 / 0.6, 4);
    expect(scoreValue(1.4, { op: 'in', value: [0.2, 0.8] })).toBeCloseTo(1 - 0.6 / 0.6, 4);
  });
});

describe('保真度聚合 (M9)', () => {
  it('全部满足时总体保真度为 1', () => {
    const evaluation = evaluatePredicates({
      intent: intent(IntentKind.Emphasize),
      target: singleTarget('hall@1/column_c__01'),
      pose: poseLookingNorth(2, 0.5),
      effects: { highlight: [], transparent: [], hidden: [] },
      scene: scene(1),
    });
    const report = aggregate(evaluation);
    // 近距离下占比与无遮挡都应满足
    expect(report.overall).toBeGreaterThan(0.85);
  });

  it('远距离时强调意图的保真度下降，且报告冲突', () => {
    const far = evaluateFidelity({
      intent: intent(IntentKind.Emphasize, [predicate.coverageAtLeast(0.5)]),
      target: singleTarget('hall@1/column_c__01'),
      pose: poseLookingNorth(60, 0.5),
      effects: { highlight: [], transparent: [], hidden: [] },
      scene: scene(1),
    });
    expect(far.report.overall).toBeLessThan(0.6);
    expect(far.report.conflicts.length).toBeGreaterThan(0);
    // 冲突必须带人类可读的说明（FR-19 的告知载体）
    expect(far.report.conflicts[0].note).toBeTruthy();
  });

  it('保真度对不可满足的约束给出低分', () => {
    // 要求占比 >= 2.0：物理上不可能（画面占比最大为 1）
    const impossible = evaluateFidelity({
      intent: intent(IntentKind.Emphasize, [predicate.coverageAtLeast(2)]),
      target: singleTarget('hall@1/column_c__01'),
      pose: poseLookingNorth(4, 0.5),
      effects: { highlight: [], transparent: [], hidden: [] },
      scene: scene(1),
    });
    expect(impossible.report.overall).toBeLessThan(0.9);
    expect(impossible.report.conflicts.some((c) => c.measure === 'screenCoverage')).toBe(true);
  });
});

describe('重定向保真度（§4.2.3 的第 2 条）', () => {
  it('两次都把意图表达得很好时，一致性与总体保真度都高', () => {
    const s = scene(1);
    const pose = poseLookingNorth(3, 0.5);
    const result = evaluateRedirectionFidelity(
      { pose, effects: { highlight: [], transparent: [], hidden: [] }, target: singleTarget('hall@1/column_c__01') },
      { pose, effects: { highlight: [], transparent: [], hidden: [] }, target: singleTarget('hall@1/column_c__01') },
      intent(IntentKind.Emphasize),
      s,
    );
    expect(result.consistency).toBeCloseTo(1, 5);
    expect(result.overall).toBeCloseTo(result.after.report.overall, 5);
  });

  it('新旧位姿对同一意图表达差异很大时，一致性下降', () => {
    const s = scene(1);
    const result = evaluateRedirectionFidelity(
      { pose: poseLookingNorth(2, 0.5), effects: { highlight: [], transparent: [], hidden: [] }, target: singleTarget('hall@1/column_c__01') },
      { pose: poseLookingNorth(50, 0.5), effects: { highlight: [], transparent: [], hidden: [] }, target: singleTarget('hall@1/column_c__01') },
      intent(IntentKind.Emphasize),
      s,
    );
    expect(result.consistency).toBeLessThan(0.9);
  });
});

describe('关系型目标 (REVEAL_RELATION)', () => {
  it('两个相距很远的构件无法同框时，coVisible 谓词不满足', () => {
    const s = testScene(1);
    const a = s.components[0]; // 原点
    const b = s.components[2]; // x = 5
    const pose = poseLookingNorth(4, 0.5); // 只盯着原点看
    const evaluation = evaluateFidelity({
      intent: intent(IntentKind.RevealRelation),
      target: relationTarget(a.id, b.id),
      pose,
      effects: { highlight: [], transparent: [], hidden: [] },
      scene: s,
    });
    // 强约束下这个构图很难满足，至少不应是满分
    expect(evaluation.report.overall).toBeLessThan(1);
  });
});
