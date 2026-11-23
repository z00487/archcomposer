/**
 * 基础几何类型
 * 依据：《项目概要设计文档》§5.2
 *
 * 纯数据、可 JSON 序列化，不含 Three.js 类型（约束 C-1 / C-4）。
 *
 * ⚠️ **定义位置**：这三个类型与 `Pose` 的字段定义在 **L1 的 `core/math.ts`** 里，
 * 本文件只做 re-export。原因是 L1 不允许有任何依赖，而 L1 的向量/投影工具又
 * 必须用到这些类型——若把它们定义在 L3，L1 就得反过来 import L3，依赖方向
 * 立刻反转。这里的 re-export 保证「业务代码从 `domain/types/` 取类型」这一
 * 约定（概要设计 §7.2 硬规定 2）仍然成立。
 */
export type { Vec3, Quat, Aabb } from '../../core/math.ts';
export { clonePose, poseDistance } from '../../core/math.ts';

import type { Vec3, Quat } from '../../core/math.ts';

/**
 * 位姿 = 位置 + 朝向 + 视野角。
 *
 * 显式携带 fovY 的理由（概要设计 §5.2）：Navisworks 的 Viewpoint 把 FOV 作为视点的一
 * 部分保存；若我们的位姿不含 FOV，就无法与之对等比较，也无法在重定向时保持
 * 「构图松紧」这一意图。
 */
export interface Pose {
  position: Vec3;
  quaternion: Quat;
  /** 垂直视野角，弧度 */
  fovY: number;
}
