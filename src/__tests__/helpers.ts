/**
 * 测试用的构造辅助（不属于夹具，属于「造对象」的工具）。
 *
 * 与 `fixtures.ts` 的分工：`fixtures.ts` 造的是**一整个场景**（几个手算得出的盒子），
 * 本文件造的是**单个构件对象**——用于临时往场景里补一个构件，把某个边界情形测出来。
 */
import type { SceneComponent } from '../domain/types/solver.ts';
import type { ComponentSemantics } from '../domain/types/component.ts';
import { deriveSemantics } from '../domain/naming/naming.ts';

/**
 * 由构件名造一个 `SceneComponent`（语义**由名字解析得出**，与生产路径一致）。
 *
 * 这条「语义从名字来」是刻意的：如果测试里手写 `semantics`，那么
 * 「命名规范与实现不一致」这类问题就永远测不出来（测试自己掩盖了它）。
 */
export function toSceneComponentLike(
  id: string,
  kind?: ComponentSemantics['kind'],
  size: [number, number, number] = [0.6, 1, 0.6],
  center: [number, number, number] = [0, 0.5, 0],
): SceneComponent {
  const nodeName = id.slice(id.indexOf('/') + 1);
  const parsed = deriveSemantics(nodeName);
  void kind; // 保留参数以便调用处标注意图，但语义一律以解析结果为准
  return {
    id,
    semantics: parsed,
    aabbMin: [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2],
    aabbMax: [center[0] + size[0] / 2, center[1] + size[1] / 2, center[2] + size[2] / 2],
    visible: true,
    replaceable: true,
  };
}
