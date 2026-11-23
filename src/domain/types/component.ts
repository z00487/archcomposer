/**
 * 构件身份与语义类型
 * 依据：《项目概要设计文档》§5.3、《命名与语义标注规范》§5、§7
 */
import type { ComponentKind } from './vocabulary.ts';

/** 稳定构件 ID，形如 "demohall@1/column_e_01"（规范 §7.1） */
export type ComponentId = string;

/** 语义标签。支撑 FR-4（语义）与 FR-16（同类替换） */
export interface ComponentSemantics {
  kind: ComponentKind;
  /** 规范化部位串，段间用 '-'（规范 §7.2）。如 "e"、"se"、"c-front"、"e-front-1" */
  part: string;
  /** 人类可读名，用于 UI 与旁白占位。如 "东侧前檐斗拱" */
  label: string;
}

/** 构件引用（引用而非快照，概要设计 §6.2） */
export interface ComponentRef {
  id: ComponentId;
  semantics: ComponentSemantics;
}
