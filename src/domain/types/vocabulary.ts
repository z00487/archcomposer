/**
 * 受控词表（词表真源）
 *
 * 依据：《命名与语义标注规范》§5。本文档与代码必须逐项一致。
 *
 * 两条使用约定（规范 §5.3）：
 *  - 解析外部模型时**宽容**：表外词归为 unknown 并记警告，不阻断加载；
 *  - 生成模型时**严格**：表外词直接报错，说明代码与规范已偏离。
 */

// ── §5.1 构件类型词表 ─────────────────────────────────────────────
export const ComponentKind = {
  Unknown: 'unknown',
  Plinth: 'plinth',
  Column: 'column',
  ColumnBase: 'columnbase',
  Dougong: 'dougong',
  Beam: 'beam',
  Purlin: 'purlin',
  Rafter: 'rafter',
  Ridge: 'ridge',
  Roof: 'roof',
  Gable: 'gable',
  Bracket: 'bracket',
} as const;
export type ComponentKind = (typeof ComponentKind)[keyof typeof ComponentKind];

/** 类型词 → 中文名（用于生成 label） */
export const KIND_LABELS: Record<ComponentKind, string> = {
  unknown: '未知构件',
  plinth: '台基',
  column: '柱',
  columnbase: '柱础',
  dougong: '斗拱',
  beam: '梁',
  purlin: '檩',
  rafter: '椽',
  ridge: '正脊',
  roof: '屋面',
  gable: '山墙',
  bracket: '支撑件',
};

/** 可作为 FR-16 替换目标的类型（unknown 与 bracket 被排除，规范 §5.1 / §5.3） */
export const REPLACEABLE_KINDS: ReadonlySet<ComponentKind> = new Set([
  ComponentKind.Column,
  ComponentKind.ColumnBase,
  ComponentKind.Dougong,
  ComponentKind.Beam,
  ComponentKind.Purlin,
  ComponentKind.Rafter,
  ComponentKind.Roof,
  ComponentKind.Gable,
]);

// ── §5.2.1 侧向定位 ──────────────────────────────────────────────
export const SIDE = { East: 'e', West: 'w', Center: 'c' } as const;
export type Side = (typeof SIDE)[keyof typeof SIDE];
export const SIDE_LABELS: Record<Side, string> = { e: '东侧', w: '西侧', c: '中央' };

// ── §5.2.2 檐面定位 ──────────────────────────────────────────────
export const EAVE = { Front: 'front', Back: 'back', Mid: 'mid' } as const;
export type Eave = (typeof EAVE)[keyof typeof EAVE];
export const EAVE_LABELS: Record<Eave, string> = {
  front: '前檐',
  back: '后檐',
  mid: '中间跨',
};

// ── §5.2.3 转角 ─────────────────────────────────────────────────
/** 注意：首个字母表示檐面（n = 后檐 / s = 前檐），末字母表示侧向（e = 东 / w = 西）。
 *  故 'ne' 是「后檐东转角」。规范 §5.2.3 专门写明了这条反直觉之处。 */
export const CORNER = { SE: 'se', SW: 'sw', NE: 'ne', NW: 'nw' } as const;
export type Corner = (typeof CORNER)[keyof typeof CORNER];
export const CORNER_LABELS: Record<Corner, string> = {
  se: '前檐东转角',
  sw: '前檐西转角',
  ne: '后檐东转角',
  nw: '后檐西转角',
};

// ── §5.2.4 檩的层序号 ────────────────────────────────────────────
export const PURLIN_LAYERS = [1, 2, 3] as const;
export type PurlinLayer = (typeof PURLIN_LAYERS)[number];
export const PURLIN_LAYER_LABELS: Record<PurlinLayer, string> = {
  1: '檐檩',
  2: '金檩',
  3: '脊檩',
};

// ── 按类型允许的定位词集合（§4.11 速查表的机器可读形式） ─────────
/** 每种类型允许出现在名字中的定位词。解析器据此逐段校验。 */
export const ALLOWED_LOCATORS: Record<ComponentKind, ReadonlySet<string>> = {
  unknown: new Set(),
  plinth: new Set(),
  column: new Set([...Object.values(SIDE)]),
  columnbase: new Set([...Object.values(SIDE)]),
  dougong: new Set([...Object.values(SIDE), ...Object.values(EAVE), ...Object.values(CORNER)]),
  beam: new Set([...Object.values(SIDE)]),
  purlin: new Set([
    ...Object.values(SIDE),
    ...Object.values(EAVE),
    ...PURLIN_LAYERS.map(String),
  ]),
  rafter: new Set([...Object.values(SIDE), ...Object.values(EAVE)]),
  ridge: new Set(),
  roof: new Set([EAVE.Front, EAVE.Back]),
  gable: new Set([SIDE.East, SIDE.West]),
  bracket: new Set(),
};

/** 类型词集合（含 unknown，用于判定名字首段是否合法） */
export const KNOWN_KINDS: ReadonlySet<string> = new Set(Object.values(ComponentKind));
