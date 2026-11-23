/**
 * 语义标注文件的序列化（规范 §6.3 格式、§8.1 要求）
 *
 * 规范 §8.1 要求生成器**自己**写出 `<name>.semantics.json`。理由不是「加载器需要」，
 * 而是它给出一份**可独立校验的清单**：
 *
 *   从名字解析出的语义  vs  文件里写的语义 —— 二者不一致就是 bug
 *
 * 这是一个廉价的自检机制，把「命名规范被正确执行」这件事变成可自动验证的。
 *
 * 本文件属 L3 领域层，不得 import three。
 */
import type { GeneratedComponent, GeneratedModel } from './generate-hall.ts';

export interface SemanticsFileComponent {
  node: string;
  kind: string;
  part: string;
  label: string;
  /** 生成器产出的一律为 "generated"，与人工标注（"manual"）区分 */
  confidence: 'manual' | 'inferred' | 'generated';
}

export interface SemanticsFile {
  schemaVersion: number;
  model: string;
  unit: 'm';
  note: string;
  components: SemanticsFileComponent[];
}

/**
 * 把生成结果写成 §6.3 的语义文件结构。
 *
 * 注意：这里**直接用 `component.semantics`**，而不是重新解析节点名。
 * 一致性由 `smoke.ts` 的验收 4 独立核对（重新解析一遍再比对），
 * 因此这里复用不会让校验变成同义反复。
 */
export function toSemanticsFile(model: GeneratedModel): SemanticsFile {
  return {
    schemaVersion: 1,
    model: model.fileName,
    unit: 'm',
    note: '由程序化生成器自动写出（规范 §8.1），非人工标注',
    components: model.components.map(componentEntry),
  };
}

function componentEntry(c: GeneratedComponent): SemanticsFileComponent {
  return {
    node: c.nodeName,
    kind: c.semantics.kind,
    part: c.semantics.part,
    label: c.semantics.label,
    confidence: 'generated',
  };
}

/** 序列化为 JSON 文本（缩进 2，字段顺序稳定，便于 diff） */
export function serializeSemanticsFile(model: GeneratedModel): string {
  return `${JSON.stringify(toSemanticsFile(model), null, 2)}\n`;
}
