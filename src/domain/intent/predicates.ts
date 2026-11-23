/**
 * L3 领域层 · M7 谓词求值
 *
 * 依据：《项目概要设计文档》§5.5「统一形状」、§4.2.3「底层量 → 保真度」两步法。
 *
 * **本文件是「意图可度量」这条主张的实现落点。** 这里把每条约束谓词换算成一个
 * [0,1] 的满足度，而换算所依赖的全部是纯几何量（投影、夹角、射线求交），
 * 因此整个文件不 import three，可以在 Node 下批量跑（约束 C-1）。
 *
 * 底层的可测量量沿用了 CinemaTraj 那套可微评分族的思路（可见性、距离、高度），
 * 但把「可微」换成了「可算」——第一版求解器是候选采样，不需要梯度
 * （概要设计 §6.2 的立场 2）。
 */
import type { ComponentId } from '../types/component.ts';
import type {
  IntentPredicate,
  MeasureName,
  PredicateValue,
} from '../types/intent.ts';
import type {
  FidelityInput,
  PredicateEvaluation,
  SceneComponent,
  SceneSummary,
} from '../types/solver.ts';
import { targetIds } from '../types/solver.ts';
import type { Aabb, Pose, Vec3 } from '../types/geometry.ts';
import {
  aabbCenter,
  aabbContainsPoint,
  aabbSize,
  projectPoint,
  rayAabbIntersect,
  v3dot,
  v3length,
  v3normalize,
  v3sub,
  clamp,
} from '../../core/math.ts';

/** 取谓词作用的对象 ID：subjects 非空则用 subjects，否则默认作用于步骤 target。 */
export function resolveSubjects(predicate: IntentPredicate, target: FidelityInput['target']): ComponentId[] {
  return predicate.subjects.length > 0 ? predicate.subjects : targetIds(target);
}

// ── 单个可测量量的计算 ─────────────────────────────────────────

/**
 * 目标在画面中的投影占比。
 *
 * **算法**：把构件 AABB 的 8 个角点投影到 NDC，取包围它们的屏幕矩形面积
 * （相对整幅画面 = 4，因为 NDC 是 2×2），再乘一个「可见性折扣」。
 *
 * **为什么用 AABB 投影而不是逐三角形栅格化**：求解器要在几十毫秒内评估上千个
 * 候选（NFR-3 的 5 秒预算），逐三角形太慢；而「占比」这个量本来就只需要估到
 * 能区分「主体」与「陪衬」，AABB 投影足够。
 *
 * **可见性折扣的理由**：一个被完全挡住的构件在几何上仍占很大面积，但视觉上
 * 占比为 0。若不折扣，`EMPHASIZE` 的约束会被「藏在后面的大家伙」虚假满足。
 */
export function measureScreenCoverage(
  component: SceneComponent,
  pose: Pose,
  scene: SceneSummary,
): number {
  const box: Aabb = { min: component.aabbMin, max: component.aabbMax };
  const corners = aabbCorners(box);

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let anyFront = false;
  for (const corner of corners) {
    const p = projectPoint(corner, pose, scene.aspect);
    if (p.depth <= 1e-4) continue; // 在相机后方
    anyFront = true;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!anyFront || minX > maxX || minY > maxY) return 0;

  // 裁到画面内：完全在画面外的部分不贡献占比
  const clippedMinX = clamp(minX, -1, 1);
  const clippedMaxX = clamp(maxX, -1, 1);
  const clippedMinY = clamp(minY, -1, 1);
  const clippedMaxY = clamp(maxY, -1, 1);
  const width = Math.max(0, clippedMaxX - clippedMinX);
  const height = Math.max(0, clippedMaxY - clippedMinY);
  const area = (width * height) / 4; // NDC 全幅面积 = 2 × 2

  const visible = measureVisibleFraction(component, pose, scene);
  return clamp(area * visible, 0, 1);
}

/** AABB 的 8 个角点。 */
function aabbCorners(b: Aabb): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [b.min[0], b.max[0]]) {
    for (const y of [b.min[1], b.max[1]]) {
      for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
    }
  }
  return out;
}

/**
 * 目标被遮挡的程度 → 返回 [0,1] 的「可见比例」。
 *
 * **算法**：从相机向构件 AABB 中心与 8 个角点连射线，逐条检测是否被其它构件的
 * AABB 挡住（射线与 AABB 求交，且交点必须比目标更近）。没被挡住的射线比例
 * 就是可见比例。
 *
 * **为什么对多个点采样而不是只取中心**：只测中心的话，一根细柱挡在正中间就会
 * 让整个大构件判为「全遮挡」，而实际视觉上还有大片可见——这会让 `unoccluded`
 * 这个布尔量过于敏感。9 条射线的代价在候选评估中可接受。
 */
export function measureVisibleFraction(
  component: SceneComponent,
  pose: Pose,
  scene: SceneSummary,
  ignoredIds: ComponentId[] = [],
): number {
  const center = aabbCenter({ min: component.aabbMin, max: component.aabbMax });
  const corners = aabbCorners({ min: component.aabbMin, max: component.aabbMax });
  const samples: Vec3[] = [center, ...corners];

  let clear = 0;
  for (const sample of samples) {
    if (isUnoccluded(pose.position, sample, component.id, scene, ignoredIds)) clear += 1;
  }
  return clear / samples.length;
}

/**
 * 从 from 到 to 的视线是否无遮挡（不含自身）。
 *
 * **这条函数有一个实测踩出来的坑，必须记下来。**
 *
 * 最初的实现是「射线与任何其它构件的 AABB 相交，且交点比目标近 → 判为被挡」。
 * 在生成的厅堂上跑，它把**孤零零一根柱子**判成了「可见度仅 11%」——而实际
 * 上那根柱子前面什么也没有。逐条打印 27 条采样射线后发现：被判为遮挡的，
 * 全是 **AABB 包含了采样点自身**的那些邻接构件——
 *
 *   · 柱子的底面角点落在**柱础**的 AABB 内（柱础 y 0~0.16，角点 y = 0）；
 *   · 柱子的顶面角点落在**屋面无斗拱**的 AABB 内（角点 y = 4.0 正好是屋面下沿）。
 *
 * 也就是说：**AABB 是包围盒，不是实体**。两个构件在几何上紧密相接时，它们的
 * 包围盒必然重叠，于是邻接被误判成了遮挡。对古建这种构件层层叠压的模型，
 * 这个误判是系统性的、不是偶发的。
 *
 * 修法是加一条判据：**如果采样点本身就落在某个构件的包围盒内部（在容差内），
 * 那这个构件就不是「挡在前面」，而是「贴在旁边」**——跳过它。
 * 真正的遮挡物（如挡在柱子前的廊柱）不会包含目标的采样点，因此仍然会被抓到。
 *
 * 容差取一个与场景尺度无关的小常数：AABB 已按构件实际尺寸构造，
 * 相邻构件之间的重叠量是「面接触」量级，用一个小的绝对容差即可。
 */
export function isUnoccluded(
  from: Vec3,
  to: Vec3,
  selfId: ComponentId,
  scene: SceneSummary,
  ignoredIds: ComponentId[] = [],
): boolean {
  const dir = v3sub(to, from);
  const distance = v3length(dir);
  if (distance < 1e-6) return true;
  const unit = v3normalize(dir);

  for (const other of scene.components) {
    if (other.id === selfId) continue;
    if (ignoredIds.includes(other.id)) continue;
    if (!other.visible) continue;

    const box: Aabb = { min: other.aabbMin, max: other.aabbMax };
    // ★ 邻接而非遮挡：采样点落在对方包围盒内（含容差）时，对方是「贴着的邻居」
    if (aabbContainsPoint(box, to, ADJACENCY_TOLERANCE)) continue;

    const t = rayAabbIntersect(from, unit, box);
    // 命中的交点必须严格落在「相机与目标之间」。保留一个相对余量，
    // 避免擦着表面掠过（掠射）被算成遮挡——那在几何上几乎不可见，
    // 在数值上却会让「无遮挡」这条布尔约束随机翻转。
    if (t !== null && t > GRAZING_TOLERANCE && t < distance * (1 - GRAZING_RELATIVE)) return false;
  }

  return true;
}

/**
 * 邻接容差（米）。取 1 毫米：AABB 的「面接触」重叠在这个量级，
 * 而真正的遮挡物与目标之间总有可观的间距。
 */
const ADJACENCY_TOLERANCE = 1e-3;
/** 掠射容差：交点离相机至少这么远才算「在相机前面」。 */
const GRAZING_TOLERANCE = 1e-3;
/** 相对的掠射余量：交点离目标表面不足「距离的千分之一」时不算遮挡。 */
const GRAZING_RELATIVE = 1e-3;

/** 目标是否在视锥内（AABB 中心与至少一个角点可见）。 */
export function measureVisible(component: SceneComponent, pose: Pose, scene: SceneSummary): number {
  const center = aabbCenter({ min: component.aabbMin, max: component.aabbMax });
  const c = projectPoint(center, pose, scene.aspect);
  if (c.depth > 0 && c.onScreen) return 1;
  for (const corner of aabbCorners({ min: component.aabbMin, max: component.aabbMax })) {
    const p = projectPoint(corner, pose, scene.aspect);
    if (p.depth > 0 && p.onScreen) return 1;
  }
  return 0;
}

/** 两个构件是否同时可见（都用 measureVisible 判）。 */
export function measureCoVisible(
  a: SceneComponent,
  b: SceneComponent,
  pose: Pose,
  scene: SceneSummary,
): number {
  return measureVisible(a, pose, scene) === 1 && measureVisible(b, pose, scene) === 1 ? 1 : 0;
}

/**
 * 两个构件在画面中的归一化距离。
 *
 * 用 AABB 中心投影后的 NDC 距离。若任一不在画面内，返回一个「很远」的大值
 * （√8 是 NDC 对角线的两倍，足以让 `in` 区间判定为不满足），而不是返回 NaN——
 * NaN 会让加权求和整链变 NaN，是最难排查的一类 bug。
 */
export function measureScreenDistance(
  a: SceneComponent,
  b: SceneComponent,
  pose: Pose,
  scene: SceneSummary,
): number {
  const ca = projectPoint(aabbCenter({ min: a.aabbMin, max: a.aabbMax }), pose, scene.aspect);
  const cb = projectPoint(aabbCenter({ min: b.aabbMin, max: b.aabbMax }), pose, scene.aspect);
  if (ca.depth <= 0 || cb.depth <= 0) return Math.SQRT2 * 2;
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

/**
 * 相机相对目标的高度比。
 *
 * 定义：`sin(仰角)` = 「相机相对目标中心的竖直分量」/「二者距离」。
 * 取值为 -1（正下方）~ +1（正上方），0 表示同一水平面。
 *
 * **为什么不用「相机高度 / 目标高度」这种直观比值**：那种定义与 Z 轴朝向有关且
 * 无界（相机很高时趋于无穷），而保真度要求所有量归一化到 [0,1]。正弦版本天然
 * 有界，且「俯视程度」的语义直接。
 */
export function measureElevationRatio(
  component: SceneComponent,
  pose: Pose,
): number {
  const center = aabbCenter({ min: component.aabbMin, max: component.aabbMax });
  const rel = v3sub(pose.position, center);
  const distance = v3length(rel);
  if (distance < 1e-6) return 0;
  return clamp(rel[1] / distance, -1, 1);
}

/**
 * 上下文构件的可见比例。
 *
 * 上下文 = 步骤 target 之外的、当前「参与场景」的构件。第一版取
 * 「与目标同类或相邻的可见构件」作为上下文集合（这样「保留结构上下文」
 * 才有具体的对象），由调用方在 `scene` 里通过 `replaceable`/`visible` 标记。
 */
export function measureContextVisible(
  contextIds: ComponentId[],
  pose: Pose,
  scene: SceneSummary,
  targetComponentIds: ComponentId[],
): number {
  const pool = contextIds.filter((id) => !targetComponentIds.includes(id));
  if (pool.length === 0) return 1; // 没有上下文时视为平凡满足
  let visible = 0;
  for (const id of pool) {
    const comp = scene.components.find((c) => c.id === id);
    if (!comp) continue;
    if (measureVisible(comp, pose, scene) === 1) visible += 1;
  }
  return visible / pool.length;
}

// ── 谓词 → 满足度 ──────────────────────────────────────────────

/**
 * 计算一条谓词的实测值。
 *
 * **注意这里没有 `switch (intent.kind)`**——只有 `switch (predicate.measure)`。
 * 这是 §5.5「统一形状」设计的直接体现：加一个新意图类型只需换谓词组合，
 * 本函数一个字都不用改（NFR-7）。
 */
export function measurePredicate(
  predicate: IntentPredicate,
  input: FidelityInput,
  contextIds: ComponentId[] = [],
): number {
  const subjectIds = resolveSubjects(predicate, input.target);
  const comps = subjectIds
    .map((id) => input.scene.components.find((c) => c.id === id))
    .filter((c): c is SceneComponent => c !== undefined);

  const measure: MeasureName = predicate.measure;
  switch (measure) {
    case 'screenCoverage': {
      const comp = comps[0];
      return comp ? measureScreenCoverage(comp, input.pose, input.scene) : 0;
    }
    case 'visible': {
      const comp = comps[0];
      return comp ? measureVisible(comp, input.pose, input.scene) : 0;
    }
    case 'unoccluded': {
      const comp = comps[0];
      return comp ? measureVisibleFraction(comp, input.pose, input.scene, input.effects.hidden) : 0;
    }
    case 'coVisible': {
      if (comps.length < 2) return 0;
      return measureCoVisible(comps[0], comps[1], input.pose, input.scene);
    }
    case 'screenDistance': {
      if (comps.length < 2) return 0;
      return measureScreenDistance(comps[0], comps[1], input.pose, input.scene);
    }
    case 'elevationRatio': {
      const comp = comps[0];
      return comp ? measureElevationRatio(comp, input.pose) : 0;
    }
    case 'contextVisible': {
      return measureContextVisible(contextIds, input.pose, input.scene, subjectIds);
    }
    default:
      return 0;
  }
}

/** 把实测值按谓词的比较符折算成 [0,1] 的满足度。 */
export function scoreValue(measured: number, test: PredicateValue): number {
  switch (test.op) {
    case '>=':
      if (measured >= test.value) return 1;
      if (test.value <= 0) return 1;
      return clamp(measured / test.value, 0, 1);
    case '<=':
      if (measured <= test.value) return 1;
      if (measured <= 0) return 1;
      return clamp(test.value / measured, 0, 1);
    case '==':
      // 布尔量退化为 0 / 1；数值量用相对误差的线性折扣
      if (test.value === 1 || test.value === 0) return measured === test.value ? 1 : 0;
      return clamp(1 - Math.abs(measured - test.value) / Math.max(Math.abs(test.value), 1e-6), 0, 1);
    case 'in': {
      const [lo, hi] = test.value;
      if (measured >= lo && measured <= hi) return 1;
      const span = Math.max(hi - lo, 1e-6);
      if (measured < lo) return clamp(1 - (lo - measured) / span, 0, 1);
      return clamp(1 - (measured - hi) / span, 0, 1);
    }
    default:
      return 0;
  }
}

/** 谓词要求的可读描述，用于冲突报告（如 ">= 0.25"）。 */
export function describeRequirement(test: PredicateValue): string {
  switch (test.op) {
    case '>=':
      return `>= ${trim(test.value)}`;
    case '<=':
      return `<= ${trim(test.value)}`;
    case '==':
      return `= ${trim(test.value)}`;
    case 'in':
      return `∈ [${trim(test.value[0])}, ${trim(test.value[1])}]`;
    default:
      return '';
  }
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

/** 是否严格满足（布尔量为 1，数值量达到阈值）。 */
export function isSatisfied(predicate: IntentPredicate, measured: number): boolean {
  const t = predicate.test;
  switch (t.op) {
    case '>=':
      return measured >= t.value - 1e-9;
    case '<=':
      return measured <= t.value + 1e-9;
    case '==':
      return Math.abs(measured - t.value) <= 1e-9;
    case 'in':
      return measured >= t.value[0] - 1e-9 && measured <= t.value[1] + 1e-9;
    default:
      return false;
  }
}

/** 求值全部谓词，得到逐条评估结果。 */
export function evaluatePredicates(
  input: FidelityInput,
  contextIds: ComponentId[] = [],
): PredicateEvaluation[] {
  return input.intent.predicates.map((p) => {
    const measured = measurePredicate(p, input, contextIds);
    return {
      predicate: p,
      measured,
      score: scoreValue(measured, p.test),
      required: describeRequirement(p.test),
      satisfied: isSatisfied(p, measured),
    };
  });
}

/**
 * 构件 AABB 的「尺度」——最长边，用于判断「这个构件在画面里够不够大」这类
 * 与距离有关的判断（求解器采样距离时要用）。
 */
export function componentScale(component: SceneComponent): number {
  const size = aabbSize({ min: component.aabbMin, max: component.aabbMax });
  return Math.max(size[0], size[1], size[2], 0.05);
}

/** 相机到构件中心的距离。 */
export function distanceToComponent(component: SceneComponent, pose: Pose): number {
  return v3length(v3sub(pose.position, aabbCenter({ min: component.aabbMin, max: component.aabbMax })));
}

/** 目标中心相对相机的方位角（弧度），绕 Y 轴。俯角采样需要它。 */
export function azimuthToComponent(component: SceneComponent, from: Vec3): number {
  const center = aabbCenter({ min: component.aabbMin, max: component.aabbMax });
  const rel = v3sub(center, from);
  return Math.atan2(rel[0], rel[2]);
}

/** 视线与构件「朝向」的点积，用于判断是从正面还是背后看（垂直度）。 */
export function facingDot(component: SceneComponent, pose: Pose): number {
  const forward = v3normalize(v3sub(
    aabbCenter({ min: component.aabbMin, max: component.aabbMax }),
    pose.position,
  ));
  const size = aabbSize({ min: component.aabbMin, max: component.aabbMax });
  // 用「最薄的轴」当作构件朝向：古建构件中柱/梁/檩都是长条状，薄轴更接近其法向
  const axes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let minAxis = 0;
  for (let i = 1; i < 3; i += 1) if (size[i] < size[minAxis]) minAxis = i;
  return Math.abs(v3dot(forward, axes[minAxis]));
}
