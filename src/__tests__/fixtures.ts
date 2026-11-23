/**
 * 测试用的共享夹具。
 *
 * **为什么要造一个「手算得出答案」的小场景**，而不是直接用生成的厅堂：
 * 生成的厅堂有 86 个构件，几何关系复杂，任何断言失败都难以判断是「代码错了」
 * 还是「我以为的几何关系本来就不对」。手工造的 4 个盒子每个都放在容易推算的
 * 位置，断言里的期望值可以手算验证——这是测试能真正发现问题而非「跟着实现走」
 * 的前提。
 */
import type { SceneComponent, SceneSummary, TargetRef } from '../domain/types/solver.ts';
import type { ComponentSemantics } from '../domain/types/component.ts';

export function semantics(kind: ComponentSemantics['kind'], part = ''): ComponentSemantics {
  return { kind, part, label: `${kind}${part ? ` ${part}` : ''}` };
}

/** 造一个轴对齐的盒子构件。 */
export function box(
  id: string,
  kind: ComponentSemantics['kind'],
  center: [number, number, number],
  size: [number, number, number],
  visible = true,
): SceneComponent {
  return {
    id,
    semantics: semantics(kind),
    aabbMin: [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2],
    aabbMax: [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2],
    visible,
    replaceable: kind !== 'unknown' && kind !== 'bracket',
  };
}

/**
 * 标准测试场景：原点处一个「柱子」（边长 1），
 * 北侧 5 米处一个大「屋面」（边长 4），东侧 5 米处一个「柱础」。
 *
 *   +Z 南
 *   −Z 北（屋面在 z = -5）
 *   +X 东（柱础在 x = +5）
 */
export function testScene(aspect = 1): SceneSummary {
  return {
    components: [
      box('hall@1/column_c__01', 'column', [0, 0.5, 0], [1, 1, 1]),
      box('hall@1/roof_front', 'roof', [0, 2, -5], [4, 0.6, 4]),
      box('hall@1/columnbase_e__01', 'columnbase', [5, 0.1, 0], [0.8, 0.2, 0.8]),
      box('hall@1/beam_c__01', 'beam', [0, 3, 0], [0.4, 0.6, 6]),
      box('hall@1/hidden_x', 'rafter', [0, 0, 0], [0.2, 0.2, 0.2], false),
    ],
    boundsMin: [-3, -1, -7],
    boundsMax: [6, 4, 2],
    aspect,
    modelPrefix: 'hall',
  };
}

export function singleTarget(id: string, kind: ComponentSemantics['kind'] = 'column'): TargetRef {
  return { form: 'single', component: { id, semantics: semantics(kind) } };
}

export function relationTarget(a: string, b: string): TargetRef {
  return {
    form: 'relation',
    from: { id: a, semantics: semantics('dougong') },
    to: { id: b, semantics: semantics('purlin') },
    relation: 'bear',
  };
}

/**
 * 站在原点**正南** `distance` 米、高 `height` 米处，朝北（-Z）看的相机位姿。
 *
 * ⚠️ 朝向用的是**单位四元数**而不是「绕 Y 转 180°」。这是个容易搞反的地方：
 * 相机（与 three.js 一致）默认看向自身局部坐标的 **-Z**，因此相机在 +Z 侧、
 * 要看原点，需要的正是**不做任何旋转**。若写成绕 Y 的 180°，视线会变成 +Z，
 * 相机就背对着场景了——所有占比都会算成 0。
 */
export function poseLookingNorth(
  distance = 10,
  height = 2,
): { position: [number, number, number]; quaternion: [number, number, number, number]; fovY: number } {
  return {
    position: [0, height, distance],
    quaternion: [0, 0, 0, 1],
    fovY: Math.PI / 4,
  };
}
