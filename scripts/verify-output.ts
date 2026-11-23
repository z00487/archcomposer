/**
 * 交付物自检：核对 public/models 下的产出文件
 *
 * 运行：node --experimental-strip-types scripts/verify-output.ts
 *
 * 检查的是一条**最强的一致性链**（规范 §8.5 第 4 条）：
 *   几何 JSON 里的节点名  →  重新解析出的语义  →  语义文件里写的语义
 * 三者必须两两一致。任何一环不同，说明规范没被忠实执行。
 */
import { readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveComponentId, deriveSemantics, validateNames } from '../src/domain/naming/naming.ts';
import type { GeometryFile } from '../src/runtime/generated-model.ts';
import { parseStoryboard } from '../src/app/io/io.ts';
import { checkModelCompatibility, validateStoryboard } from '../src/domain/storyboard/storyboard.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(process.argv[2] ?? join(here, '..', 'public', 'models'));

const geo = JSON.parse(readFileSync(join(dir, 'demohall.geometry.json'), 'utf8')) as GeometryFile;
const sem = JSON.parse(readFileSync(join(dir, 'demohall.semantics.json'), 'utf8')) as {
  model: string;
  unit: string;
  components: Array<{ node: string; kind: string; part: string; label: string }>;
};

let problems = 0;
const bad = (msg: string) => { problems++; console.log(`  ✗ ${msg}`); };

// 1. 语义文件的 model 字段与几何文件的产出名一致（规范 §7.4 阻断项）
if (sem.model !== `${geo.prefix}.geometry.json`) {
  bad(`语义文件的 model="${sem.model}" 与几何文件 "${geo.prefix}.geometry.json" 不一致`);
}

// 2. 数量一致且一一对应
if (sem.components.length !== geo.components.length) {
  bad(`语义条目 ${sem.components.length} ≠ 几何构件 ${geo.components.length}`);
}
const byNode = new Map(sem.components.map((c) => [c.node, c]));

// 3. 逐构件三链核对
for (const c of geo.components) {
  const s = byNode.get(c.nodeName);
  if (!s) { bad(`语义文件缺少节点 ${c.nodeName}`); continue; }
  const re = deriveSemantics(c.nodeName);
  if (re.kind !== s.kind) bad(`${c.nodeName}: kind 解析为 ${re.kind}，文件写 ${s.kind}`);
  if (re.part !== s.part) bad(`${c.nodeName}: part 解析为 "${re.part}"，文件写 "${s.part}"`);
  if (re.label !== s.label) bad(`${c.nodeName}: label 解析为 "${re.label}"，文件写 "${s.label}"`);
  // 几何文件里内嵌的 id 也必须与按名字重算的一致
  const expectId = deriveComponentId(geo.prefix, c.nodeName);
  if (c.id !== expectId) bad(`${c.nodeName}: id="${c.id}"，应为 "${expectId}"`);
}

// 4. 加载报告的阻断与警告
const report = validateNames(geo.prefix, geo.components.map((c) => c.nodeName));
if (report.duplicates.length) bad(`重复名：${report.duplicates.join(', ')}`);
if (report.warnings.length) bad(`警告 ${report.warnings.length} 条：${report.warnings[0]}`);

// ── 5. ★ 示例分镜与模型的一致性 ────────────────────────────────
//
// **为什么把这项检查放在这里而不是单元测试里**：`src/__tests__/` 里的测试
// 刻意跑在「无 Node 全局对象」的环境下（tsconfig 的 `types` 只有 vite/client），
// 以此**强制**领域层不依赖 Node。而这项检查天然要读磁盘上的两个文件，
// 属于「交付物自检」的范畴——与这里已有的三链核对是同一类事情。
//
// 检查什么：用户打开程序后第一眼看到的示例分镜，绝不能引用不存在的构件。
// 模型改了而示例忘了重生成，用户的第一印象就是「这个软件坏了」。
const exampleFile = join(dir, '..', 'examples', '入口厅堂讲解.storyboard.json');
let sampleChecked = false;
try {
  const parsed = parseStoryboard(readFileSync(exampleFile, 'utf8'));
  if (!parsed.ok || !parsed.storyboard) {
    bad(`示例分镜无法解析：${parsed.errors[0] ?? '未知原因'}`);
  } else {
    const ids = new Set(geo.components.map((c) => deriveComponentId(geo.prefix, c.nodeName)));
    const validation = validateStoryboard(parsed.storyboard, ids);
    for (const e of validation.errors) bad(`示例分镜：${e}`);
    for (const w of validation.warnings) bad(`示例分镜警告：${w}`);

    const compatibility = checkModelCompatibility(parsed.storyboard, {
      prefix: geo.prefix,
      componentCount: geo.components.length,
    });
    if (!compatibility.compatible) bad(`示例分镜与模型不兼容：${compatibility.reason}`);

    // 缓存的 semantics 必须与由当前名字解析出的结果一致
    for (const step of parsed.storyboard.steps) {
      const refs = step.target.form === 'single'
        ? [step.target.component]
        : [step.target.from, step.target.to];
      for (const ref of refs) {
        const nodeName = ref.id.slice(ref.id.indexOf('/') + 1);
        const expected = deriveSemantics(nodeName);
        if (ref.semantics.kind !== expected.kind || ref.semantics.part !== expected.part) {
          bad(`示例分镜：${ref.id} 缓存的 semantics 与名字解析结果不一致`);
        }
      }
      if (step.solve === 'solved' && !step.camera) {
        bad(`示例分镜：步骤「${step.title}」标为已求解却没有机位`);
      } else if (step.camera) {
        const finite = [...step.camera.position, ...step.camera.quaternion, step.camera.fovY];
        if (!finite.every((v) => Number.isFinite(v))) {
          bad(`示例分镜：步骤「${step.title}」的机位含非有限值`);
        }
      }
    }
    // ── 6. 示例分镜的**可复现性**：重新生成一遍，除时间戳外应逐字节相同 ──
    //
    // 这条检查的意义：示例分镜里的每一个机位都是求解器算出来的，而不是手编的。
    // 若哪天有人手改了这份 JSON，「重新生成一遍」就会对不上，检查立刻失败——
    // 从而保证「示例 = 当前代码 + 当前模型的真实产出」这个性质不会被悄悄破坏。
    const regenPath = join(dir, '..', 'examples', '__verify_regen.json');
    try {
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', join(here, 'emit-example.ts'), regenPath],
        { cwd: join(here, '..'), stdio: 'pipe' },
      );
      const strip = (t: string) => t.replace(/"updatedAt":\s*"[^"]+"/, '');
      if (strip(readFileSync(regenPath, 'utf8')) !== strip(readFileSync(exampleFile, 'utf8'))) {
        bad('示例分镜与「重新生成一遍」的结果不一致——它可能被手工改过（请运行 npm run gen:example）');
      }
    } finally {
      rmSync(regenPath, { force: true });
    }

    sampleChecked = true;
  }
} catch (err) {
  bad(`示例分镜读取失败：${(err as Error).message}（请运行 npm run gen:example）`);
}

console.log(
  problems === 0
    ? `  ✓ 交付物自检通过：${geo.components.length} 个构件，三链一致，零警告${
        sampleChecked ? '；示例分镜与模型一致' : ''
      }`
    : `  ✗ 交付物自检失败：${problems} 处问题`,
);
if (problems > 0) process.exitCode = 1;
