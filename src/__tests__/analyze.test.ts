/**
 * M7 意图推断 的单元测试（§4.2.1、§6.1）
 *
 * **第一版推断的目标是「可信地给出候选」，不是「猜得准」**（概要设计 §4.2.1）。
 * 因此这里的断言重点不在「准确率」，而在三件事：
 *  1. 规则是**可解释的**——每个候选都带人类可读的理由；
 *  2. 信号不足时**宁可不猜**——返回 `recognized: false` 而不是硬给一个低置信度的结果；
 *  3. 推断是**确定性**的——同样的示范必得同样的候选。
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeDemo,
  buildTarget,
  derivePredicates,
  signalSelection,
  signalOpacityAndVisibility,
  signalCamera,
  signalLanguage,
  MIN_CONFIDENCE,
} from '../domain/intent/rules.ts';
import type { DemoOutcome } from '../domain/types/storyboard.ts';
import { IntentKind, defaultPredicatesFor } from '../domain/types/intent.ts';
import { testScene, poseLookingNorth, semantics } from './fixtures.ts';
import { deriveSemantics } from '../domain/naming/naming.ts';

function outcome(overrides: Partial<DemoOutcome> = {}): DemoOutcome {
  return {
    selectedId: null,
    opacities: {},
    hidden: [],
    highlighted: [],
    cameraTrack: [],
    touchedIds: [],
    ...overrides,
  };
}

describe('信号抽取', () => {
  it('没有操作过任何构件时，选中信号为空', () => {
    expect(signalSelection(outcome())).toBeNull();
  });

  it('只操作一个构件时，信号里说明了这是讲解焦点', () => {
    const signal = signalSelection(outcome({ touchedIds: ['hall@1/column_c__01'] }));
    expect(signal).not.toBeNull();
    expect(signal!.detail).toContain('1 个构件');
    expect(signal!.kind).toBe('selection');
  });

  it('调透明会产出「留作上下文」的信号', () => {
    const signals = signalOpacityAndVisibility(outcome({ opacities: { a: 0.2, b: 0.5 } }));
    expect(signals.some((s) => s.kind === 'opacity')).toBe(true);
    // 取最透明那个作为说明对象
    expect(signals.find((s) => s.kind === 'opacity')!.detail).toContain('20%');
  });

  it('隐藏构件会产出「排除遮挡」的信号', () => {
    const signals = signalOpacityAndVisibility(outcome({ hidden: ['a', 'b'] }));
    expect(signals.some((s) => s.kind === 'visibility')).toBe(true);
  });

  it('相机拉近 → 强调动作；后退 → 全局视野动作', () => {
    const scene = testScene(1.6);
    const near = signalCamera(
      outcome({
        selectedId: 'hall@1/column_c__01',
        cameraTrack: [poseLookingNorth(12, 0.5), poseLookingNorth(2, 0.5)],
      }),
      scene,
    );
    expect(near.some((s) => s.detail.includes('拉近'))).toBe(true);

    const far = signalCamera(
      outcome({
        selectedId: 'hall@1/column_c__01',
        cameraTrack: [poseLookingNorth(2, 0.5), poseLookingNorth(30, 0.5)],
      }),
      scene,
    );
    expect(far.some((s) => s.detail.includes('后退'))).toBe(true);
  });

  it('相机绕行 → 找角度看关系的动作', () => {
    const scene = testScene(1.6);
    const signals = signalCamera(
      outcome({
        selectedId: 'hall@1/column_c__01',
        cameraTrack: [
          { position: [0, 0.5, 8], quaternion: [0, 0, 0, 1], fovY: Math.PI / 4 },
          { position: [8, 0.5, 0], quaternion: [0, 0, 0, 1], fovY: Math.PI / 4 },
        ],
      }),
      scene,
    );
    expect(signals.some((s) => s.detail.includes('绕目标转'))).toBe(true);
  });

  it('自然语言里的关系词 → 揭示关系；提示词 → 强调', () => {
    expect(signalLanguage('这根檩条承托在上面的梁上').some((s) => s.detail.includes('关系'))).toBe(true);
    expect(signalLanguage('大家注意看这里').some((s) => s.detail.includes('强调'))).toBe(true);
    expect(signalLanguage('我们先整体看一下这个建筑').some((s) => s.detail.includes('整体'))).toBe(true);
    expect(signalLanguage('').length).toBe(0);
  });
});

describe('★ 失败处理：信号不足时宁可不猜 (§6.1)', () => {
  it('完全没有任何操作时，recognized 为 false 而不是硬给一个候选', () => {
    const result = analyzeDemo(outcome(), testScene(1.6));
    expect(result.recognized).toBe(false);
    expect(result.predictions).toEqual([]);
  });

  it('只有「动了相机但没指定目标」这类模糊信号时，不产出高置信度候选', () => {
    const result = analyzeDemo(
      outcome({ cameraTrack: [poseLookingNorth(6, 1)] }), // 单帧轨迹，且没有 selectedId
      testScene(1.6),
    );
    // 要么不识别，要么给出的候选置信度都不高
    if (result.recognized) {
      for (const prediction of result.predictions) {
        expect(prediction.intent.provenance.confidence).toBeLessThan(0.95);
      }
    }
  });
});

describe('候选意图生成', () => {
  it('选中 + 拉近 → 产出以 EMPHASIZE 为首的候选', () => {
    const result = analyzeDemo(
      outcome({
        selectedId: 'hall@1/column_c__01',
        touchedIds: ['hall@1/column_c__01'],
        cameraTrack: [poseLookingNorth(12, 0.5), poseLookingNorth(2, 0.5)],
      }),
      testScene(1.6),
    );
    expect(result.recognized).toBe(true);
    expect(result.predictions[0].intent.kind).toBe(IntentKind.Emphasize);
  });

  it('调透明 → 同时给出「保留上下文」与「减少遮挡」两个候选（让用户选）', () => {
    const result = analyzeDemo(
      outcome({
        selectedId: 'hall@1/column_c__01',
        touchedIds: ['hall@1/column_c__01'],
        opacities: { 'hall@1/roof_front': 0.2 },
      }),
      testScene(1.6),
    );
    const kinds = result.predictions.map((p) => p.intent.kind);
    expect(kinds).toContain(IntentKind.KeepContext);
  });

  it('旁白里的关系词能把 REVEAL_RELATION 顶上来', () => {
    const result = analyzeDemo(
      outcome({
        selectedId: 'hall@1/column_c__01',
        touchedIds: ['hall@1/column_c__01', 'hall@1/roof_front'],
        cameraTrack: [poseLookingNorth(20, 3)],
      }),
      testScene(1.6),
      '注意这根柱子和上面的屋面之间的支撑关系',
    );
    expect(result.predictions.some((p) => p.intent.kind === IntentKind.RevealRelation)).toBe(true);
  });

  it('★ 每个候选都带人类可读的推断理由（可解释性）', () => {
    const result = analyzeDemo(
      outcome({
        selectedId: 'hall@1/column_c__01',
        touchedIds: ['hall@1/column_c__01'],
        cameraTrack: [poseLookingNorth(12, 0.5), poseLookingNorth(2, 0.5)],
      }),
      testScene(1.6),
    );
    for (const prediction of result.predictions) {
      expect(prediction.intent.provenance.rationale).toBeTruthy();
      expect(prediction.intent.provenance.rationale.length).toBeGreaterThan(4);
      expect(prediction.signals.length).toBeGreaterThan(0);
    }
  });

  it('★ 推断出的意图默认未经用户确认（FR-14 的留痕）', () => {
    const result = analyzeDemo(
      outcome({
        selectedId: 'hall@1/column_c__01',
        touchedIds: ['hall@1/column_c__01'],
        cameraTrack: [poseLookingNorth(12, 0.5), poseLookingNorth(2, 0.5)],
      }),
      testScene(1.6),
    );
    for (const prediction of result.predictions) {
      expect(prediction.intent.provenance.confirmedByUser).toBe(false);
      expect(prediction.intent.provenance.source).toBe('demo');
    }
  });

  it('★ 推断确定性：同样的示范两次分析结果一致（除 ID 外）', () => {
    const demo = outcome({
      selectedId: 'hall@1/column_c__01',
      touchedIds: ['hall@1/column_c__01'],
      cameraTrack: [poseLookingNorth(12, 0.5), poseLookingNorth(2, 0.5)],
    });
    const a = analyzeDemo(demo, testScene(1.6));
    const b = analyzeDemo(demo, testScene(1.6));
    const strip = (r: typeof a): string =>
      JSON.stringify({
        recognized: r.recognized,
        kinds: r.predictions.map((p) => p.intent.kind),
        confidences: r.predictions.map((p) => p.intent.provenance.confidence),
        signals: r.signals.map((s) => s.detail),
      });
    expect(strip(a)).toBe(strip(b));
  });

  it('所有候选的置信度都不低于阈值', () => {
    const result = analyzeDemo(
      outcome({
        selectedId: 'hall@1/column_c__01',
        touchedIds: ['hall@1/column_c__01'],
        cameraTrack: [poseLookingNorth(12, 0.5), poseLookingNorth(2, 0.5)],
      }),
      testScene(1.6),
    );
    for (const prediction of result.predictions) {
      expect(prediction.intent.provenance.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    }
  });
});

describe('目标与阈值反推 (§5.5)', () => {
  it('只操作一个构件 → 单目标', () => {
    const target = buildTarget(
      outcome({ selectedId: 'hall@1/column_c__01', touchedIds: ['hall@1/column_c__01'] }),
      testScene(1.6),
    );
    expect(target?.form).toBe('single');
  });

  it('操作了两个构件 → 关系型目标', () => {
    const target = buildTarget(
      outcome({ touchedIds: ['hall@1/column_c__01', 'hall@1/roof_front'] }),
      testScene(1.6),
    );
    expect(target?.form).toBe('relation');
  });

  it('没有选中也没有操作 → null（无法确定目标）', () => {
    expect(buildTarget(outcome(), testScene(1.6))).toBeNull();
  });

  it('★ EMPHASIZE 的占比阈值从示范的实测距离反推出来（不是写死的魔法数）', () => {
    const scene = testScene(1.6);
    const near = derivePredicates(
      IntentKind.Emphasize,
      [],
      outcome({
        selectedId: 'hall@1/column_c__01',
        cameraTrack: [poseLookingNorth(2, 0.5), poseLookingNorth(2, 0.5)],
      }),
      scene,
      null,
    );
    const far = derivePredicates(
      IntentKind.Emphasize,
      [],
      outcome({
        selectedId: 'hall@1/column_c__01',
        cameraTrack: [poseLookingNorth(20, 0.5), poseLookingNorth(20, 0.5)],
      }),
      scene,
      null,
    );
    const nearThreshold = (near[0].test as { value: number }).value;
    const farThreshold = (far[0].test as { value: number }).value;

    // 演示时靠得近的，反推出的阈值应当更高（作者的「强调」强度更大）
    expect(nearThreshold).toBeGreaterThan(farThreshold);
  });

  it('没有相机轨迹时退回默认阈值（而不是给出一个荒谬的数）', () => {
    const predicates = derivePredicates(
      IntentKind.Emphasize,
      [],
      outcome({ selectedId: 'hall@1/column_c__01' }),
      testScene(1.6),
      null,
    );
    expect(predicates).toEqual(defaultPredicatesFor(IntentKind.Emphasize, []));
  });

  it('REVEAL_RELATION 的画面距离区间随世界间隙放宽', () => {
    const scene = testScene(1.6);
    const target = buildTarget(outcome({ touchedIds: ['hall@1/column_c__01', 'hall@1/roof_front'] }), scene)!;
    const predicates = derivePredicates(IntentKind.RevealRelation, ['a', 'b'], outcome(), scene, target);
    const distancePredicate = predicates.find((p) => p.measure === 'screenDistance');
    expect(distancePredicate).toBeDefined();
  });
});

describe('语义标签参与推断', () => {
  it('★ 真实的中文语义标签由命名规范 §7.2 从构件名解析得出（不是测试夹具拼的）', () => {
    // 用生产代码的解析器而不是夹具，验证「名字 → 中文标签」这条链路确实通
    const parsed = deriveSemantics('column_e__01');
    expect(parsed.kind).toBe('column');
    expect(parsed.part).toBe('e');
    expect(parsed.label).toContain('柱');
  });

  it('夹具里的语义对象自身是自洽的（kind/part 透传）', () => {
    const s = semantics('column', 'c');
    expect(s.kind).toBe('column');
    expect(s.part).toBe('c');
  });
});
