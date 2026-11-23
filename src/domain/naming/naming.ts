/**
 * 命名与语义标注规范（文档三）的可执行实现
 *
 * 实现的内容：
 *  - §3.1  节点名语法（正则）
 *  - §7.1  ID 派生算法
 *  - §7.2  语义解析算法（含 part 规范化）
 *  - §7.3  同类判定与候选排序
 *  - §7.4  校验（重复名阻断等，见 validateNames）
 *
 * 本文件属于 L1 基础设施，**不得 import three**。全部为纯函数，可直接单测。
 */
import {
  ALLOWED_LOCATORS,
  CORNER_LABELS,
  EAVE_LABELS,
  KIND_LABELS,
  KNOWN_KINDS,
  ComponentKind,
  PURLIN_LAYER_LABELS,
  SIDE_LABELS,
  type Corner,
  type Eave,
  type PurlinLayer,
  type Side,
} from '../types/vocabulary.ts';
import type { ComponentId, ComponentSemantics } from '../types/component.ts';

/** 规范版本号，写入 ID 中（规范 §7.1） */
export const NAMING_FORMAT_VERSION = 1;

/**
 * §3.1 节点名语法。
 *
 * 捕获组：1=类型词，2=定位段的整体（可重复），3=单段定位词，4=序号（两位数字）
 *
 * 注意 `(\.[0-9]{2})?` 而非 `(_[0-9]{2})?`——序号前缀是**双**下划线。
 */
export const NODE_NAME_PATTERN = /^([a-z][a-z0-9]*)((?:_[a-z0-9]+)*)(?:__([0-9]{2}))?$/;

/** 解析后的节点名结构 */
export interface ParsedNodeName {
  kind: ComponentKind;
  /** 定位段原文（未规范化），如 ['e', 'front', '1'] */
  locators: string[];
  /** 序号，如 '01'；无序号则为 null */
  sequence: string | null;
  /** 名字本身是否符合 §3.1 语法 */
  wellFormed: boolean;
  /** 解析过程中的告警（不阻断，规范 §5.3「解析宽容」） */
  warnings: string[];
}

/**
 * §7.2 解析节点名。
 *
 * 宽容策略：语法不合规或定位词不在允许集合内时，**不报错**，把该段并入 part 原文
 * 并记警告。理由见规范 §5.3——外部模型不可控，宽容能避免整批构件因一个词失效。
 */
export function parseNodeName(nodeName: string): ParsedNodeName {
  const warnings: string[] = [];
  const match = NODE_NAME_PATTERN.exec(nodeName);

  if (!match) {
    return {
      kind: ComponentKind.Unknown,
      locators: [],
      sequence: null,
      wellFormed: false,
      warnings: [`节点名「${nodeName}」不符合 §3.1 语法`],
    };
  }

  const kindWord = match[1];
  const locatorBlob = match[2] ?? '';
  const sequence = match[3] ?? null;

  const kind = KNOWN_KINDS.has(kindWord)
    ? (kindWord as ComponentKind)
    : ComponentKind.Unknown;
  if (kind === ComponentKind.Unknown) {
    warnings.push(`类型词「${kindWord}」不在 §5.1 词表内`);
  }

  // 去掉前导 '_' 再切分
  const rawLocators = locatorBlob ? locatorBlob.slice(1).split('_') : [];

  const allowed = ALLOWED_LOCATORS[kind];
  const locators: string[] = [];
  for (const word of rawLocators) {
    if (!allowed.has(word)) {
      warnings.push(
        `定位词「${word}」不在类型「${kindWord}」的允许集合内（§4.11 速查表），已原样保留`,
      );
    }
    locators.push(word);
  }

  // 宽容恢复序号：语法上没给出 __ 序号，但末段是纯数字。
  //
  // 只有当该类型的定位词里**根本不使用数字**时才做这个恢复——否则会把檩的层号
  // （`purlin_e_front_9` 里的 `9`）误判成序号，而层号本就该留在 part 里并因越界报警。
  const usesNumericLocators = [...allowed].some((w) => /^[0-9]+$/.test(w));
  let seq = sequence;
  if (seq === null && locators.length > 1 && !usesNumericLocators) {
    const last = locators[locators.length - 1];
    if (/^[0-9]+$/.test(last)) {
      seq = last;
      locators.pop();
      warnings.push(
        `序号「${last}」应写作 __${last.padStart(2, '0')}（§3.1 要求双下划线 + 两位补零）`,
      );
    }
  }

  return { kind, locators, sequence: seq, wellFormed: true, warnings };
}

/** §7.2 part 的规范化：段间用 '-'（规范 §7.2） */
export function normalizePart(locators: string[]): string {
  return locators.join('-');
}

/**
 * §7.2 label 生成：定位中文名 + 类型中文名拼接。
 *
 * 特例：檩的层号中文名已自带「檩」字（檐檩/金檩/脊檩），此时不再追加类型名，
 * 避免拼出「檐檩檩」。
 */
export function buildLabel(kind: ComponentKind, locators: string[]): string {
  const parts: string[] = [];
  let lastWasPurlinLayer = false;

  for (const word of locators) {
    const layer = PURLIN_LAYER_LABELS[Number(word) as PurlinLayer];
    lastWasPurlinLayer = layer !== undefined;
    parts.push(
      SIDE_LABELS[word as Side] ??
        EAVE_LABELS[word as Eave] ??
        CORNER_LABELS[word as Corner] ??
        layer ??
        word, // 未识别则原样输出
    );
  }

  const head = parts.join('');
  return kind === ComponentKind.Purlin && lastWasPurlinLayer ? head : head + KIND_LABELS[kind];
}

/** 模型前缀的规范化（规范 §7.1 步骤 2） */
export function modelPrefixFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]*$/, '');
  const ascii = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ascii.length > 0) return ascii;
  // 文件名不含 ASCII 可保留字符（如纯中文）→ 用短哈希（规范 §7.1）
  return shortHash(base);
}

/** 8 位十六进制短哈希，用于非 ASCII 文件名 */
function shortHash(input: string): string {
  // FNV-1a 32 位，确定性、无依赖
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * §7.1 ID 派生算法。
 *
 * 形式： <模型前缀>@<格式版本>/<构件名>
 *
 * 与概要设计 v1.0 的差异：本文按**构件名**派生，而非**节点路径**。理由见规范 §7.1
 * ——路径会随容器结构调整而变，构件名不会。
 */
export function deriveComponentId(modelPrefix: string, nodeName: string): ComponentId {
  return `${modelPrefix}@${NAMING_FORMAT_VERSION}/${nodeName}`;
}

/** 从 ID 中取回构件名（不含模型前缀与版本） */
export function nodeNameFromId(id: ComponentId): string {
  const slash = id.indexOf('/');
  return slash < 0 ? id : id.slice(slash + 1);
}

/** 从 ID 中取回模型前缀 */
export function modelPrefixFromId(id: ComponentId): string {
  const at = id.indexOf('@');
  return at < 0 ? '' : id.slice(0, at);
}

/** 解析出完整语义（§7.2） */
export function deriveSemantics(nodeName: string): ComponentSemantics {
  const parsed = parseNodeName(nodeName);
  return {
    kind: parsed.kind,
    part: normalizePart(parsed.locators),
    label: buildLabel(parsed.kind, parsed.locators),
  };
}

/** 一个节点名对应的完整结果（配置校验用） */
export interface NameValidation {
  nodeName: string;
  id: ComponentId;
  semantics: ComponentSemantics;
  warnings: string[];
}

/**
 * §7.4 校验一批节点名，返回加载报告。
 *
 * 只做「能否派生 ID / 语义」这一层；几何与唯一性之外的阻断项由调用方处理。
 * 重复名是**阻断项**（规范 §7.4），因此单独返回。
 */
export interface NameReport {
  entries: NameValidation[];
  /** 重复的构件名（空数组表示无重复 → 通过） */
  duplicates: string[];
  warnings: string[];
}

export function validateNames(modelPrefix: string, nodeNames: string[]): NameReport {
  const seen = new Map<string, number>();
  for (const name of nodeNames) {
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name);

  const entries: NameValidation[] = nodeNames.map((nodeName) => {
    const semantics = deriveSemantics(nodeName);
    const parsed = parseNodeName(nodeName);
    return {
      nodeName,
      id: deriveComponentId(modelPrefix, nodeName),
      semantics,
      warnings: parsed.warnings,
    };
  });

  const warnings = entries.flatMap((e) => e.warnings);
  return { entries, duplicates, warnings };
}

/**
 * §7.3 同类构件判定：kind 相等即同类。
 *
 * `unknown` 与 `bracket` 不作为替换目标（规范 §5.3）。
 */
export function isSameKind(a: ComponentSemantics, b: ComponentSemantics): boolean {
  if (a.kind === ComponentKind.Unknown || b.kind === ComponentKind.Unknown) return false;
  if (a.kind === ComponentKind.Bracket || b.kind === ComponentKind.Bracket) return false;
  return a.kind === b.kind;
}

/** 转角词分解（§5.2.3）：首字母表示檐面（n=后檐/s=前檐），末字母表示侧向（e=东/w=西） */
const CORNER_DECOMPOSED: Record<string, { eave: 'front' | 'back'; side: Side }> = {
  se: { eave: 'front', side: 'e' },
  sw: { eave: 'front', side: 'w' },
  ne: { eave: 'back', side: 'e' },
  nw: { eave: 'back', side: 'w' },
};

/** 侧向词的对侧映射（§5.2.1 与 §5.2.3 合并，用于 §7.3 排序规则 1） */
const OPPOSITE_SIDE: Record<string, string> = {
  e: 'w',
  w: 'e',
  c: 'c',
  se: 'sw',
  sw: 'se',
  ne: 'nw',
  nw: 'ne',
};

/** 从 part 中取出侧向词（§5.2.1 或 §5.2.3） */
function sideOf(part: string): string | null {
  for (const seg of part.split('-')) {
    if (seg in OPPOSITE_SIDE) return seg;
  }
  return null;
}

/**
 * 从 part 中取出檐面词（§5.2.2，并可从转角词中分解出檐面）。
 *
 * 这一步是必需的：转角词 `se`/`sw`/`ne`/`nw` **本身就编码了檐面**
 * （`s` = 前檐、`n` = 后檐），若不分解，则「以转角为起点」的排序会拿不到原檐面，
 * §7.3 的规则 2 就会失效。
 */
function eaveOf(part: string): string | null {
  for (const seg of part.split('-')) {
    if (seg === 'front' || seg === 'back' || seg === 'mid') return seg;
    const corner = CORNER_DECOMPOSED[seg];
    if (corner) return corner.eave;
  }
  return null;
}

/** 位置形态：转角 / 柱头 / 无。用于 §7.3 排序规则 3 */
function formOf(part: string): 'corner' | 'eave' | 'plain' {
  const segs = part.split('-');
  if (segs.some((s) => s in CORNER_DECOMPOSED)) return 'corner';
  if (segs.some((s) => s === 'front' || s === 'back' || s === 'mid')) return 'eave';
  return 'plain';
}

/**
 * §7.3 候选排序：为「换同类构件」给出推荐顺序。
 *
 * 优先级（规范 §7.3）：
 *  1. 侧向词相反者最前
 *  2. 檐面词相同者次之
 *  3. 位置形态相同者优先
 *  4. 其余按 ID 字典序
 */
export function rankReplacementCandidates(
  origin: ComponentSemantics,
  candidates: Array<{ id: ComponentId; semantics: ComponentSemantics }>,
): Array<{ id: ComponentId; semantics: ComponentSemantics }> {
  const originSide = sideOf(origin.part);
  const originEave = eaveOf(origin.part);
  const originForm = formOf(origin.part);
  const expectedOpposite = originSide ? OPPOSITE_SIDE[originSide] : null;

  const score = (c: ComponentSemantics): number[] => {
    const s = sideOf(c.part);
    const e = eaveOf(c.part);
    const f = formOf(c.part);
    return [
      expectedOpposite !== null && s === expectedOpposite ? 0 : 1, // 规则 1
      originEave !== null && e === originEave ? 0 : 1, // 规则 2
      f === originForm ? 0 : 1, // 规则 3
    ];
  };

  return candidates
    .map((c) => ({ c, key: score(c.semantics) }))
    .sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
      }
      return a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0; // 规则 4
    })
    .map((x) => x.c);
}
