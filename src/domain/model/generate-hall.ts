/**
 * 程序化模型生成器 —— 单层三开间悬山厅堂
 *
 * 依据：《命名与语义标注规范》§8。
 *
 * 四条硬约束（规范 §8.4）：
 *  1. **确定性**：同参数必得同结果（含节点顺序与 ID），不使用随机数；
 *  2. **不依赖渲染**：只产出纯几何描述，不要求 WebGL 上下文，可在 Node 下运行；
 *  3. **节点顺序稳定**：按 类型 → 侧向 → 檐面 → 序号 的确定顺序遍历；
 *  4. **几何中心与原点**：+X 东、+Y 上、+Z 南；原点是平面几何中心 + 台基顶面。
 *
 * 本文件属于 L3 领域层，**不得 import three**（约束 C-1）。
 *
 * 产出规模（默认参数）：台基 1 + 柱 8 + 柱础 8 + 斗拱 8 + 梁 6 + 檩 18
 *   + 椽 32 + 正脊 1 + 屋面 2 + 山墙 2 = **86 个构件**，落在规范 §2.3 的 80~140 内。
 */
import type { Aabb, Vec3 } from '../types/geometry.ts';
import type { ComponentId, ComponentSemantics } from '../types/component.ts';
import { deriveComponentId, deriveSemantics } from '../naming/naming.ts';

/** 圆柱轴向（运行时据此设旋转；领域层不碰 three） */
export type Axis = 'x' | 'y' | 'z';

/** 几何形状描述（纯数据，由运行时层翻译成 THREE.Mesh） */
export type ShapeSpec =
  | { form: 'box'; size: Vec3 }
  | { form: 'cylinder'; radius: number; height: number; radialSegments: number; axis: Axis }
  /** 三角柱：底面沿 Z 展开、高沿 Y、厚度沿 X。用于悬山山墙 */
  | { form: 'prism'; base: number; height: number; thickness: number };

export type MaterialKey = 'stone' | 'wood' | 'woodDark' | 'roofTile' | 'wall' | 'ridge';

/** 一个生成出来的构件 */
export interface GeneratedComponent {
  id: ComponentId;
  /** 节点名，与规范 §3 一致 */
  nodeName: string;
  semantics: ComponentSemantics;
  shape: ShapeSpec;
  /** 中心位置（世界坐标） */
  position: Vec3;
  /**
   * 绕 X 轴的旋转（弧度）。坡屋面与椽靠它倾斜。
   *
   * **在领域层算好、由运行时原样施加**，而不是让运行时自己推——否则预览脚本、
   * 测试脚本、渲染器各自算一遍，三处一旦不一致就会出现「测试通过但画面是错的」
   * 这类最难查的问题。这正是 §8.4 约束 2「不依赖渲染」的应有之义。
   */
  rotX: number;
  /** 构件的世界包围盒（已计入 rotX），供求解器做遮挡判断 */
  aabb: Aabb;
  /** 材质键，运行时映射到具体材质 */
  materialKey: MaterialKey;
}

/** 生成参数（规范 §8.2） */
export interface HallParams {
  /** 开间数（默认 3，即 4 列柱） */
  bayCount: number;
  /** 明间宽度（米） */
  centerBayWidth: number;
  /** 次间宽度（米） */
  sideBayWidth: number;
  /** 进深（米），即前后檐柱之间的距离 */
  depth: number;
  /** 檐柱高（米） */
  columnHeight: number;
  columnRadius: number;
  columnBaseRadius: number;
  columnBaseHeight: number;
  /** 铺作层高与水平尺寸（米） */
  dougongHeight: number;
  dougongWidth: number;
  dougongDepth: number;
  /** 梁截面（宽 × 高，米） */
  beamWidth: number;
  beamHeight: number;
  purlinRadius: number;
  /** 每个侧向-檐面组合的椽数（规范 §4.6 建议 6~10） */
  rafterCountPerSide: number;
  rafterWidth: number;
  rafterHeight: number;
  /** 正脊相对檐口的高度（米），即举高 */
  roofRise: number;
  eaveOverhang: number;
  roofThickness: number;
  gableThickness: number;
  /** 台基高（米，置于 y < 0 一侧）与其外扩（米） */
  plinthHeight: number;
  plinthMargin: number;
}

export const DEFAULT_HALL_PARAMS: HallParams = {
  bayCount: 3,
  centerBayWidth: 4.2,
  sideBayWidth: 3.4,
  depth: 6.0,
  columnHeight: 4.0,
  columnRadius: 0.18,
  columnBaseRadius: 0.26,
  columnBaseHeight: 0.16,
  dougongHeight: 0.85,
  dougongWidth: 0.72,
  dougongDepth: 0.72,
  beamWidth: 0.24,
  beamHeight: 0.38,
  purlinRadius: 0.13,
  rafterCountPerSide: 8,
  rafterWidth: 0.10,
  rafterHeight: 0.14,
  roofRise: 2.6,
  eaveOverhang: 0.9,
  roofThickness: 0.22,
  gableThickness: 0.18,
  plinthHeight: 0.45,
  plinthMargin: 0.7,
};

/** 檩的层号（规范 §5.2.4）：1 檐檩 / 2 金檩 / 3 脊檩 */
const PURLIN_LAYERS = [1, 2, 3] as const;
/** 各层在坡面上的位置，0 = 檐口，1 = 正脊 */
const PURLIN_T: Record<number, number> = { 1: 0, 2: 0.5, 3: 1 };

export interface GeneratedModel {
  prefix: string;
  /**
   * 模型文件名。
   *
   * 注意：产物是**几何 JSON** 而不是 .glb —— 规范 §8.4 约束 2 要求生成器不依赖渲染，
   * 而 GLB 导出需要 GLTFExporter（要 DOM/WebGL）。JSON 让整条链在 Node 下可跑、
   * 可被测试脚本直接读取。语义文件的 `model` 字段与本字段一致（规范 §6.3）。
   */
  fileName: string;
  params: HallParams;
  components: GeneratedComponent[];
  bounds: Aabb;
  /** 沿面阔方向的柱列 X 坐标，自西向东 */
  columnXs: number[];
  eaveZs: { front: number; back: number };
}

/**
 * 生成一座厅堂。同参数必得同结果（无随机数、遍历顺序固定）。
 */
export function generateHall(
  params: HallParams = DEFAULT_HALL_PARAMS,
  prefix = 'demohall',
): GeneratedModel {
  const P = params;
  const out: GeneratedComponent[] = [];

  const halfDepth = P.depth / 2;
  const eaveZs = { front: halfDepth, back: -halfDepth };

  const columnXs = buildColumnXs(P);
  const totalWidth = columnXs[columnXs.length - 1] - columnXs[0];
  const bayCount = columnXs.length - 1;

  const eaveY = P.columnHeight; // 檐口高 = 柱顶
  const dougongTopY = eaveY + P.dougongHeight;
  const ridgeY = dougongTopY + P.roofRise;

  const xWest = columnXs[0];
  const xEast = columnXs[columnXs.length - 1];
  const xEastInner = columnXs[columnXs.length - 2]; // 东次间柱列
  const xWestInner = columnXs[1]; // 西次间柱列

  // ── 坡屋面几何（前坡与后坡共用，s = +1 前 / -1 后） ──────────────
  const yEave = eaveY - 0.1; // 檐口（屋面下沿）高
  const runZ = halfDepth + P.eaveOverhang; // 檐口到正脊的水平距离
  const riseY = ridgeY - yEave; // 檐口到正脊的高差
  const slopeLen = Math.hypot(runZ, riseY);
  /** 沿坡面法线向内的单位方向（用「从屋脊指向檐口」的方向转 90° 得到） */
  const inward = (s: number): Vec3 => [0, -runZ / slopeLen, (-s * riseY) / slopeLen];
  /** 屋面板绕 X 的倾角 */
  const slopeRotX = (s: number): number => Math.atan2(riseY, s * runZ);
  /** 从檐口起、沿坡面的比例 t 处的屋面上一点 */
  const onSlope = (s: number, t: number, offset: number): Vec3 => {
    const p: Vec3 = [0, yEave + t * riseY, s * runZ * (1 - t)];
    const n = inward(s);
    return [p[0] + n[0] * offset, p[1] + n[1] * offset, p[2] + n[2] * offset];
  };

  // ── 1. 台基（规范 §4.10，单一整体，顶面在 y = 0）─────────────────
  const plinthWidth = totalWidth + 2 * (P.columnRadius + P.plinthMargin);
  const plinthDepthZ = P.depth + 2 * (P.columnRadius + P.plinthMargin);
  push(out, prefix, 'plinth', {
    shape: { form: 'box', size: [plinthWidth, P.plinthHeight, plinthDepthZ] },
    position: [0, -P.plinthHeight / 2, 0],
    materialKey: 'stone',
  });

  // ── 2. 柱 8 根 + 柱础 8 个（规范 §4.1 / §4.2）───────────────────
  //    序号规则：先按 X 自西向东分组、再按 Z 自前檐向后檐
  //      东端 e：前檐角 __01、后檐角 __02
  //      中间 c：前檐东次间 __01、后檐东次间 __02、前檐西次间 __03、后檐西次间 __04
  //      西端 w：前檐角 __01、后檐角 __02
  const columnSlots: Array<{ side: SideWord; seq: number; x: number; eave: EaveWord }> = [
    { side: 'e', seq: 1, x: xEast, eave: 'front' },
    { side: 'e', seq: 2, x: xEast, eave: 'back' },
    { side: 'c', seq: 1, x: xEastInner, eave: 'front' },
    { side: 'c', seq: 2, x: xEastInner, eave: 'back' },
    { side: 'c', seq: 3, x: xWestInner, eave: 'front' },
    { side: 'c', seq: 4, x: xWestInner, eave: 'back' },
    { side: 'w', seq: 1, x: xWest, eave: 'front' },
    { side: 'w', seq: 2, x: xWest, eave: 'back' },
  ];
  for (const slot of columnSlots) {
    const z = eaveZs[slot.eave];
    push(out, prefix, `column_${slot.side}__${pad(slot.seq)}`, {
      shape: {
        form: 'cylinder',
        radius: P.columnRadius,
        height: P.columnHeight,
        radialSegments: 16,
        axis: 'y',
      },
      position: [slot.x, eaveY / 2, z],
      materialKey: 'wood',
    });
    push(out, prefix, `columnbase_${slot.side}__${pad(slot.seq)}`, {
      shape: {
        form: 'cylinder',
        radius: P.columnBaseRadius,
        height: P.columnBaseHeight,
        radialSegments: 16,
        axis: 'y',
      },
      position: [slot.x, P.columnBaseHeight / 2, z],
      materialKey: 'stone',
    });
  }

  // ── 3. 斗拱 8 攒（规范 §4.3）───────────────────────────────────
  //    排他规则：转角柱上只放转角斗拱，不放柱头斗拱
  const cornerSlots: Array<{ word: CornerWord; x: number; eave: EaveWord }> = [
    { word: 'se', x: xEast, eave: 'front' },
    { word: 'sw', x: xWest, eave: 'front' },
    { word: 'ne', x: xEast, eave: 'back' },
    { word: 'nw', x: xWest, eave: 'back' },
  ];
  const dougongShape: ShapeSpec = {
    form: 'box',
    size: [P.dougongWidth, P.dougongHeight, P.dougongDepth],
  };
  for (const c of cornerSlots) {
    push(out, prefix, `dougong_${c.word}__01`, {
      shape: dougongShape,
      position: [c.x, eaveY + P.dougongHeight / 2, eaveZs[c.eave]],
      materialKey: 'woodDark',
    });
  }
  // 柱头斗拱：中间两列，每列前后各一攒（东次间 __01/__02，西次间 __01/__02）
  for (const eave of ['front', 'back'] as const) {
    const innerXs: number[] = [xEastInner, xWestInner];
    innerXs.forEach((x, i) => {
      push(out, prefix, `dougong_c_${eave}__${pad(i + 1)}`, {
        shape: dougongShape,
        position: [x, eaveY + P.dougongHeight / 2, eaveZs[eave]],
        materialKey: 'woodDark',
      });
    });
  }

  // ── 4. 梁 6 根（规范 §4.4）─────────────────────────────────────
  //    每开间 2 根，沿进深方向架设：前檐侧梁（z 0 → +depth/2）、后檐侧梁（z 0 → -depth/2）
  //    「前后不同位置」正是序号 __01 / __02 的含义
  for (let b = 0; b < bayCount; b++) {
    const side = baySideWord(b, bayCount);
    const xMid = (columnXs[b] + columnXs[b + 1]) / 2;
    (['front', 'back'] as const).forEach((eave, i) => {
      const sign = eave === 'front' ? 1 : -1;
      push(out, prefix, `beam_${side}__${pad(i + 1)}`, {
        shape: { form: 'box', size: [P.beamWidth, P.beamHeight, P.depth / 2] },
        position: [xMid, dougongTopY + P.beamHeight / 2 - 0.05, (sign * P.depth) / 4],
        materialKey: 'wood',
      });
    });
  }

  // ── 5. 檩 18 根（规范 §4.5）───────────────────────────────────
  //    侧向 × 檐面 × 层号 = 3 × 2 × 3；层号用单下划线（不是 __ 序号）
  //
  //    关于脊檩（层 3）：规范 §9.1 指出脊檩通常是**一条贯通构件**，并说明
  //    「具体做一条还是多条由生成器决定，但命名必须遵循 §4.5」。这里按命名规范
  //    保留前/后各一条，二者在正脊两侧**相抵**（间距 = 半径 × 2），合起来构成
  //    一条视觉上的脊檩，同时保住「同位置不同高度的檩属于不同类」这一可演示性。
  const purlinInset = P.roofThickness / 2 + P.rafterHeight + P.purlinRadius;
  for (const side of ['e', 'c', 'w'] as const) {
    const seg = sideSegmentX(side, columnXs);
    if (seg === null) continue;
    const [xa, xb] = seg;
    for (const eave of ['front', 'back'] as const) {
      const s = eave === 'front' ? 1 : -1;
      for (const layer of PURLIN_LAYERS) {
        const c = onSlope(s, PURLIN_T[layer], purlinInset);
        push(out, prefix, `purlin_${side}_${eave}_${layer}`, {
          shape: {
            form: 'cylinder',
            radius: P.purlinRadius,
            height: xb - xa,
            radialSegments: 12,
            axis: 'x', // 檩沿面阔方向架设
          },
          position: c,
          materialKey: 'wood',
        });
      }
    }
  }

  // ── 6. 椽 32 根（规范 §4.6）───────────────────────────────────
  //    4 个「侧向 × 檐面」组合 × 每侧 8 根；序号一律 __NN
  //    椽沿坡面自正脊铺到檐口，是密排构件——这正是它们需要 __NN 的原因
  const rafterInset = P.roofThickness / 2 + P.rafterHeight / 2;
  for (const eave of ['front', 'back'] as const) {
    const s = eave === 'front' ? 1 : -1;
    const mid = onSlope(s, 0.5, rafterInset);
    for (const side of ['e', 'w'] as const) {
      const x0 = side === 'e' ? xEastInner : xWest;
      const x1 = side === 'e' ? xEast : xWestInner;
      for (let i = 1; i <= P.rafterCountPerSide; i++) {
        const t = (i - 0.5) / P.rafterCountPerSide;
        const x = x0 + t * (x1 - x0);
        push(out, prefix, `rafter_${side}_${eave}__${pad(i)}`, {
          shape: {
            form: 'box',
            size: [P.rafterWidth, P.rafterHeight, slopeLen],
          },
          position: [x, mid[1], mid[2]],
          rotX: slopeRotX(s),
          materialKey: 'wood',
        });
      }
    }
  }

  // ── 7. 正脊（规范 §4.7，单一整体）──────────────────────────────
  push(out, prefix, 'ridge', {
    shape: { form: 'box', size: [totalWidth + P.eaveOverhang * 2, 0.28, 0.36] },
    position: [0, ridgeY + 0.14, 0],
    materialKey: 'ridge',
  });

  // ── 8. 屋面 2 片（规范 §4.8，前后坡分开便于分别讲解）────────────
  for (const eave of ['front', 'back'] as const) {
    const s = eave === 'front' ? 1 : -1;
    const mid = onSlope(s, 0.5, 0);
    push(out, prefix, `roof_${eave}`, {
      shape: {
        form: 'box',
        size: [totalWidth + P.eaveOverhang * 2, P.roofThickness, slopeLen],
      },
      position: mid,
      rotX: slopeRotX(s),
      materialKey: 'roofTile',
    });
  }

  // ── 9. 山墙 2 面（规范 §4.9）──────────────────────────────────
  //    悬山：端部是三角山面，底边沿进深展开、顶点在正脊下方。
  //    底边取檐口高（不是地面），所以这是「檐口以上的山面」——见 §8.3 的简化声明。
  const gableHeight = ridgeY - eaveY;
  for (const side of ['e', 'w'] as const) {
    const x = side === 'e' ? xEast : xWest;
    push(out, prefix, `gable_${side}`, {
      shape: { form: 'prism', base: P.depth, height: gableHeight, thickness: P.gableThickness },
      position: [x, eaveY + gableHeight / 2, 0],
      materialKey: 'wall',
    });
  }

  const components = out.map((c) => ({ ...c, aabb: aabbOf(c) }));
  return {
    prefix,
    fileName: `${prefix}.geometry.json`,
    params: P,
    components,
    bounds: boundsOf(components),
    columnXs,
    eaveZs,
  };
}

// ─────────────────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────────────────

type SideWord = 'e' | 'w' | 'c';
type EaveWord = 'front' | 'back';
type CornerWord = 'se' | 'sw' | 'ne' | 'nw';

const pad = (n: number): string => String(n).padStart(2, '0');

interface MakeInput {
  shape: ShapeSpec;
  position: Vec3;
  materialKey: MaterialKey;
  rotX?: number;
}

function push(
  sink: GeneratedComponent[],
  prefix: string,
  nodeName: string,
  input: MakeInput,
): void {
  sink.push({
    id: deriveComponentId(prefix, nodeName),
    nodeName,
    semantics: deriveSemantics(nodeName),
    shape: input.shape,
    position: input.position,
    rotX: input.rotX ?? 0,
    aabb: { min: [0, 0, 0], max: [0, 0, 0] }, // 稍后由 aabbOf 覆盖
    materialKey: input.materialKey,
  });
}

/**
 * 各柱列的 X 坐标，自西向东。
 *
 * 奇数开间（默认 3）：明间居于原点两侧，两侧依次为次间。**注意三开间是 4 列柱**
 * ——明间两侧各一列，再由次间向外各一列，原点处没有柱列。
 * 偶数开间：等分（本项目的形制不用，保留以免参数化时崩溃）。
 */
function buildColumnXs(P: HallParams): number[] {
  const hc = P.centerBayWidth / 2;
  if (P.bayCount % 2 === 1) {
    const k = (P.bayCount - 1) / 2; // 明间每侧的柱列数
    const east: number[] = [];
    for (let i = 0; i <= k; i++) east.push(hc + i * P.sideBayWidth);
    const west = east.map((x) => -x).reverse();
    return [...west, ...east];
  }
  const n = P.bayCount + 1;
  const half = hc + (P.bayCount / 2) * P.sideBayWidth;
  const step = (half * 2) / (n - 1);
  return Array.from({ length: n }, (_, i) => -half + i * step);
}

/** 某侧向词在面阔方向覆盖的 X 区间（用于檩的分段） */
function sideSegmentX(side: SideWord, columnXs: number[]): [number, number] | null {
  const last = columnXs.length - 1;
  if (side === 'w') return [columnXs[0], columnXs[1]];
  if (side === 'e') return [columnXs[last - 1], columnXs[last]];
  if (columnXs.length < 4) return null; // 不足三开间时无中段
  return [columnXs[1], columnXs[last - 1]];
}

/** 开间对应的侧向词（用于梁的命名） */
function baySideWord(bayIndex: number, totalBays: number): SideWord {
  const center = (totalBays - 1) / 2;
  if (bayIndex < center) return 'w';
  if (bayIndex > center) return 'e';
  return 'c';
}

/** 由形状、位置与倾角推出包围盒（含 rotX，供求解器做遮挡判断） */
function aabbOf(c: GeneratedComponent): Aabb {
  const h = halfExtents(c.shape);
  const [cx, cy, cz] = c.position;
  if (c.rotX === 0) {
    return { min: [cx - h[0], cy - h[1], cz - h[2]], max: [cx + h[0], cy + h[1], cz + h[2]] };
  }
  // 绕 X 旋转：只需在 (y, z) 平面里取旋转后矩形的最小/最大
  const cos = Math.cos(c.rotX);
  const sin = Math.sin(c.rotX);
  const yz: Array<[number, number]> = [
    [-h[1], -h[2]],
    [-h[1], h[2]],
    [h[1], -h[2]],
    [h[1], h[2]],
  ].map(([y, z]) => [y * cos - z * sin, y * sin + z * cos]);
  const ys = yz.map((p) => p[0]);
  const zs = yz.map((p) => p[1]);
  return {
    min: [cx - h[0], cy + Math.min(...ys), cz + Math.min(...zs)],
    max: [cx + h[0], cy + Math.max(...ys), cz + Math.max(...zs)],
  };
}

function halfExtents(shape: ShapeSpec): Vec3 {
  switch (shape.form) {
    case 'box':
      return [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2];
    case 'cylinder':
      // 圆柱按轴向上展开求包围盒
      if (shape.axis === 'y') return [shape.radius, shape.height / 2, shape.radius];
      if (shape.axis === 'x') return [shape.height / 2, shape.radius, shape.radius];
      return [shape.radius, shape.radius, shape.height / 2];
    case 'prism':
      return [shape.thickness / 2, shape.height / 2, shape.base / 2];
  }
}

function boundsOf(components: GeneratedComponent[]): Aabb {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of components) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], c.aabb.min[i]);
      max[i] = Math.max(max[i], c.aabb.max[i]);
    }
  }
  return { min, max };
}
