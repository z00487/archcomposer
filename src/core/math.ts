/**
 * L1 基础设施 · 向量 / 矩阵 / 四元数 / 投影工具
 *
 * 依据：《项目概要设计文档》§3.3（L1 提供「向量/矩阵工具」）、§5.2。
 *
 * 两条硬要求：
 *  1. **零依赖**。不得 import three，也不得 import 任何上层模块——L1 在最底下。
 *     理由：L3（领域层）的求解器与保真度模块要靠这些工具算投影与可见性，
 *     而 L3 又不许碰 three（约束 C-1）。若这里引 three，整条链就断了。
 *  2. **纯函数**。所有函数不改入参，返回新数组。分镜与意图都是纯数据（C-4），
 *     若工具函数偷偷改入参，撤销/重做与「播放不改数据」（§6.3）都会失效。
 *
 * 坐标系约定（与文档三 §2.1 一致）：+X 东、+Y 上、+Z 南；右手系；单位米。
 * 相机朝向约定与 three.js 一致：相机看向自身局部坐标的 **-Z**。
 */

// ── §5.2 基础类型（唯一定义处；domain/types/geometry.ts 从这里 re-export）──

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** 轴对齐包围盒 */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

// ── Vec3 ─────────────────────────────────────────────────────────

export const v3 = (x: number, y: number, z: number): Vec3 => [x, y, z];
export const v3zero = (): Vec3 => [0, 0, 0];
export const v3clone = (a: Vec3): Vec3 => [a[0], a[1], a[2]];
export const v3add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const v3sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const v3scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const v3mul = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
export const v3dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const v3cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const v3length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const v3distance = (a: Vec3, b: Vec3): number => v3length(v3sub(a, b));

export function v3normalize(a: Vec3): Vec3 {
  const len = v3length(a);
  return len < 1e-12 ? [0, 0, 0] : [a[0] / len, a[1] / len, a[2] / len];
}

export const v3lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

export const v3min = (a: Vec3, b: Vec3): Vec3 => [
  Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
];
export const v3max = (a: Vec3, b: Vec3): Vec3 => [
  Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]),
];

/** 绕 X 轴旋转（弧度）。生成器算坡屋面与椽的倾角时用这个（文档三 §8.3）。 */
export function rotateAroundX(p: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
}

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// ── Aabb ─────────────────────────────────────────────────────────

export function aabbOfPoints(points: Vec3[]): Aabb {
  if (points.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  let min: Vec3 = v3clone(points[0]);
  let max: Vec3 = v3clone(points[0]);
  for (const p of points) {
    min = v3min(min, p);
    max = v3max(max, p);
  }
  return { min, max };
}

export const aabbCenter = (b: Aabb): Vec3 => v3scale(v3add(b.min, b.max), 0.5);
export const aabbSize = (b: Aabb): Vec3 => v3sub(b.max, b.min);

export function aabbUnion(a: Aabb, b: Aabb): Aabb {
  return { min: v3min(a.min, b.min), max: v3max(a.max, b.max) };
}

/**
 * 点是否在包围盒内。`tolerance` 用于把「面接触」也算作在内——
 * 判断「两个构件是紧贴着的邻居」时需要它（见 `predicates.ts` 的 `isUnoccluded`）。
 */
export function aabbContainsPoint(b: Aabb, p: Vec3, tolerance = 0): boolean {
  return (
    p[0] >= b.min[0] - tolerance && p[0] <= b.max[0] + tolerance &&
    p[1] >= b.min[1] - tolerance && p[1] <= b.max[1] + tolerance &&
    p[2] >= b.min[2] - tolerance && p[2] <= b.max[2] + tolerance
  );
}

/** 两个 AABB 是否相交。用于「目标是否被遮挡物挡住」的粗判。 */
export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return (
    a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
  );
}

/**
 * 射线与 AABB 求交（slab 法），返回最近的非负参数 t，无交返回 null。
 * 用于重定向求解器判断「目标到相机之间是否有遮挡物」。
 */
export function rayAabbIntersect(origin: Vec3, dir: Vec3, box: Aabb): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const d = dir[i];
    const o = origin[i];
    if (Math.abs(d) < 1e-12) {
      if (o < box.min[i] || o > box.max[i]) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (box.min[i] - o) * inv;
    let t2 = (box.max[i] - o) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return tmin < 0 ? 0 : tmin;
}

// ── 四元数 ───────────────────────────────────────────────────────

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function quatFromAxisAngle(axis: Vec3, rad: number): Quat {
  const a = v3normalize(axis);
  const half = rad / 2;
  const s = Math.sin(half);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(half)];
}

/** 四元数乘四元数（先施加 b，再施加 a，与 three.js 的 a.multiply(b) 同序）。 */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const quatConjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export const quatLength = (q: Quat): number => Math.hypot(q[0], q[1], q[2], q[3]);

export function quatNormalize(q: Quat): Quat {
  const len = quatLength(q);
  if (len < 1e-12) return [...QUAT_IDENTITY];
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** 用四元数旋转向量。 */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 * (q_vec × v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** 球面线性插值。播放时相机位姿的插值用它（§6.3），比逐分量线性插值更稳。 */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  if (cos > 0.9995) {
    // 夹角极小，退化为线性插值后归一化，避免 sin(0) 除法
    return quatNormalize([
      lerp(a[0], bx, t), lerp(a[1], by, t), lerp(a[2], bz, t), lerp(a[3], bw, t),
    ]);
  }
  const theta = Math.acos(clamp(cos, -1, 1));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return quatNormalize([
    a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb,
  ]);
}

/**
 * 由「看向方向」构造四元数，使相机局部 -Z 轴指向 dir。
 *
 * 这是把「求解器输出的『看向哪』」翻译成位姿的最后一步。求解器在 L3 里算的是方向，
 * 而位姿存的是四元数（§5.2），二者之间的转换必须留在 L1，否则 L3 就得引 three。
 */
export function quatLookAt(dir: Vec3, up: Vec3 = [0, 1, 0]): Quat {
  const forward = v3normalize(dir);
  if (v3length(forward) < 1e-9) return [...QUAT_IDENTITY];
  let right = v3cross(forward, up);
  if (v3length(right) < 1e-9) {
    // 视线与 up 平行，换一个参考轴避免退化
    right = v3cross(forward, [0, 0, 1]);
  }
  right = v3normalize(right);
  const trueUp = v3normalize(v3cross(right, forward));

  // 旋转矩阵（列 = 相机局部 x/y/z 在世界中的方向）
  const m = [
    right[0], trueUp[0], -forward[0],
    right[1], trueUp[1], -forward[1],
    right[2], trueUp[2], -forward[2],
  ];
  return quatFromRotationMatrix3(m);
}

/**
 * ★ 环绕：把相机绕「枢轴」的 Y 轴旋转 `radians`，并重新对准枢轴。
 *
 * 这是 360° 全景环绕运镜（开题报告 §3.5、答辩 PPT 第 9 页）的唯一计算内核。
 * 抽在 L1 而不是塞进播放器里，有三个好处：
 *  - **可单测**：给定同一个位姿与角度，输出必然逐位相同；
 *  - **播放器不含几何知识**：它只负责在时间轴上取 t，再去问这个函数要位姿；
 *  - **与求解器无关**：重定向改变的是「起始机位」，环绕是叠加在它上面的相对
 *    运动，因此换目标之后「绕新目标转一圈」自动成立，不需要另写一套逻辑。
 *
 * 两条几何约定：
 *  - 只在**水平面**内旋转（绕世界 Y 轴），这样俯角在整个环绕过程中保持不变——
 *    否则相机高度会随角度起伏，观感像在颠簸；
 *  - 全程**对准枢轴**，因此枢轴在画面中始终居中，转的是建筑而不是相机视野。
 */
export function orbitAroundPivot<T extends { position: Vec3; quaternion: Quat }>(
  pose: T,
  pivot: Vec3,
  radians: number,
): T {
  const rel: Vec3 = [
    pose.position[0] - pivot[0],
    pose.position[1] - pivot[1],
    pose.position[2] - pivot[2],
  ];
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  // 绕 Y 轴的旋转矩阵：x' = x·cos + z·sin，z' = -x·sin + z·cos
  const rotated: Vec3 = [
    rel[0] * c + rel[2] * s,
    rel[1],
    -rel[0] * s + rel[2] * c,
  ];
  const position: Vec3 = [
    pivot[0] + rotated[0],
    pivot[1] + rotated[1],
    pivot[2] + rotated[2],
  ];
  // 视线方向 = 枢轴 - 相机位置
  const dir: Vec3 = [pivot[0] - position[0], pivot[1] - position[1], pivot[2] - position[2]];
  return {
    ...pose,
    position,
    quaternion: quatLookAt(dir),
  } as T;
}

/** 3×3 旋转矩阵（行主序，长度 9）→ 四元数。 */
export function quatFromRotationMatrix3(m: number[]): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return quatNormalize([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return quatNormalize([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return quatNormalize([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return quatNormalize([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}

// ── 相机与投影 ───────────────────────────────────────────────────

/** 相机的三个局部轴（世界坐标下）。 */
export interface CameraBasis {
  right: Vec3;
  up: Vec3;
  /** 相机看向的方向（世界坐标） */
  forward: Vec3;
}

export function cameraBasis(q: Quat): CameraBasis {
  return {
    right: v3normalize(quatRotate(q, [1, 0, 0])),
    up: v3normalize(quatRotate(q, [0, 1, 0])),
    forward: v3normalize(quatRotate(q, [0, 0, -1])),
  };
}

/** 一个点投影到画面上后的结果，坐标全部归一化到 [-1,1]（NDC）。 */
export interface ProjectedPoint {
  /** 画面横坐标，-1 左界 / +1 右界 */
  x: number;
  /** 画面纵坐标，-1 下界 / +1 上界 */
  y: number;
  /** 相机坐标系下的深度（正数表示在相机前方） */
  depth: number;
  /** 是否在视锥内（含深度范围与画面边界） */
  onScreen: boolean;
}

/**
 * 世界坐标 → 相机坐标 → NDC。
 *
 * 这是保真度模块（M9）与求解器（M8）都要用的最底层一步：所谓「目标在画面中的
 * 投影占比」「两构件是否同框」全部由它推出。**刻意不用 THREE.Matrix4**，
 * 因为它必须能在 Node 下跑（约束 C-1）。
 */
export function projectPoint(
  p: Vec3,
  pose: { position: Vec3; quaternion: Quat; fovY: number },
  aspect: number,
): ProjectedPoint {
  const rel = v3sub(p, pose.position);
  const basis = cameraBasis(pose.quaternion);
  const xc = v3dot(rel, basis.right);
  const yc = v3dot(rel, basis.up);
  const zc = v3dot(rel, basis.forward); // 前方为正

  if (zc <= 1e-6) {
    return { x: 0, y: 0, depth: zc, onScreen: false };
  }

  const tanHalf = Math.tan(pose.fovY / 2);
  const ndcY = yc / (zc * tanHalf);
  const ndcX = xc / (zc * tanHalf * aspect);
  const onScreen =
    ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;

  return { x: ndcX, y: ndcY, depth: zc, onScreen };
}

/**
 * 把位姿里所有 `-0` 规范成 `0`。
 *
 * **为什么需要这一步**：`-0` 在 JavaScript 里是合法的数字，`-0 === 0` 为真，
 * 但在两个地方会产生可观察的差异：
 *
 *  1. **`JSON.stringify(-0)` 输出 `0`**，因此「存盘再读回来」的位姿与内存里的
 *     不严格相等。任务三文档 §9.2 把「往返后字段完整」列为一条契约，
 *     而 `-0` 会让这条契约在深层相等比较下失败（写测试时就是这么发现的）。
 *  2. 调试时看 `-0` 与 `0` 混在一起会让人怀疑算法有问题。
 *
 * `-0` 的来源是**向量运算**：叉积、`sin(0)` 与负数的乘法都会产出 `-0`。
 * 求解器的朝向由 `quatLookAt` 算出来（里面用了两次叉积），因此它的输出里
 * 经常出现 `-0`（例如 `[-0.174…, -0, -0, 0.985…]`）。
 *
 * 处理方式是**在数据离开 L3 之前规范一次**——这样内存里的值、存盘的值、
 * 读回来的值三者完全一致，round-trip 契约才真的是「逐字段相等」。
 */
export function canonicalizePose<T extends { position: Vec3; quaternion: Quat }>(pose: T): T {
  const flush = (v: number): number => (v === 0 ? 0 : v);
  return {
    ...pose,
    position: [flush(pose.position[0]), flush(pose.position[1]), flush(pose.position[2])] as Vec3,
    quaternion: [
      flush(pose.quaternion[0]),
      flush(pose.quaternion[1]),
      flush(pose.quaternion[2]),
      flush(pose.quaternion[3]),
    ] as Quat,
  };
}

/** 位姿的深拷贝（纯数据，直接结构化克隆即可）。 */
export function clonePose<T extends { position: Vec3; quaternion: Quat; fovY: number }>(p: T): T {
  return {
    ...p,
    position: v3clone(p.position),
    quaternion: [...p.quaternion] as Quat,
  };
}

/** 两个位姿之间的位置距离（米），用于播放插值与「重定向是否剧烈」的粗判。 */
export const poseDistance = (
  a: { position: Vec3 },
  b: { position: Vec3 },
): number => v3distance(a.position, b.position);
