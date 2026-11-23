/**
 * 生成器 CLI —— 把模型产出为可交付的文件
 *
 * 运行：
 *   node --experimental-strip-types scripts/emit-model.ts [输出目录]
 *
 * 产出两个文件：
 *   <prefix>.geometry.json    —— 纯几何描述（运行时据此建 THREE.Mesh）
 *   <prefix>.semantics.json   —— 语义清单（规范 §6.3 格式，供独立校验）
 *
 * 为什么几何也走 JSON 而不是 .glb：规范 §8.4 约束 2 要求「不依赖渲染」，
 * 而 .glb 的导出需要 GLTFExporter（依赖 DOM/WebGL 环境）。JSON 让生成器
 * 在 Node 下即可完成全部工作，测试脚本也能直接读。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_HALL_PARAMS, generateHall } from '../src/domain/model/generate-hall.ts';
import { serializeSemanticsFile } from '../src/domain/model/semantics-file.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(process.argv[2] ?? join(here, '..', 'public', 'models'));

const model = generateHall(DEFAULT_HALL_PARAMS, 'demohall');

mkdirSync(outDir, { recursive: true });

const geometryPath = join(outDir, `${model.prefix}.geometry.json`);
const semanticsPath = join(outDir, `${model.prefix}.semantics.json`);

writeFileSync(
  geometryPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      prefix: model.prefix,
      unit: 'm',
      params: model.params,
      bounds: model.bounds,
      components: model.components,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

writeFileSync(semanticsPath, serializeSemanticsFile(model), 'utf8');

console.log(`已写出：`);
console.log(`  ${geometryPath}`);
console.log(`  ${semanticsPath}`);
console.log(`构件总数：${model.components.length}`);
