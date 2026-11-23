/**
 * 分层守卫：机械化强制「领域层不得依赖渲染层」（任务二 §7.2 硬规定 1 / 约束 C-1）
 *
 * 规范原文要求用 ESLint 的 no-restricted-imports 强制。本工程当前未引入 ESLint
 * （避免为一个规则引入整套 lint 工具链与配置），因此先用这个**零依赖的守卫脚本**
 * 顶上；将来接入 ESLint 时可原样保留本脚本作为 CI 的第二道保险。
 *
 * 判定方式不是「字符串前缀匹配」，而是**把相对路径归一化后判断它落在哪个层目录里**
 * ——否则 `./x/../runtime/y` 这类写法能绕过前缀匹配。
 *
 * 运行：node --experimental-strip-types scripts/check-layering.ts
 *   或 npm run check:layering
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, '..', 'src');

/**
 * 依赖方向：L1 core ← L2 runtime ← L3 domain ← L4 app ← L5 ui。
 * `domain/` 只允许依赖同层与 L1；不得依赖 L2（three 相关）、L4、L5。
 */
const FORBIDDEN_TARGETS: Array<{ target: string; why: string }> = [
  {
    target: 'runtime',
    why: 'L3 领域层不得依赖 L2 运行时（three 相关）——否则无法在 Node 下单测，也破坏「意图重定向与渲染器无关」这一核心性质',
  },
  { target: 'app', why: 'L3 不得反向依赖 L4 应用层（依赖方向必须单向）' },
  { target: 'ui', why: 'L3 不得反向依赖 L5 界面层（依赖方向必须单向）' },
];

/** 裸包名黑名单：任何层级下，领域层都不得直接 import 渲染库 */
const FORBIDDEN_PACKAGES = ['three'];
const PACKAGE_WHY =
  '渲染库只能出现在 L2 runtime 与 L5 ui；领域层的几何必须是纯数据（规范 §8.4 约束 2）';

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 抓 import/export-from 与动态 import() 的说明符 */
function importSpecifiers(text: string): string[] {
  const specs: string[] = [];
  for (const re of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of text.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

const files = collect(join(srcRoot, 'domain'));
const violations: string[] = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const shown = relative(srcRoot, file).replace(/\\/g, '/');

  for (const spec of importSpecifiers(text)) {
    const bare = FORBIDDEN_PACKAGES.find((p) => spec === p || spec.startsWith(`${p}/`));
    if (bare) {
      violations.push(`  ✗ src/${shown}:  import '${spec}'\n      理由：${PACKAGE_WHY}`);
      continue;
    }
    if (!spec.startsWith('.')) continue; // 非相对路径（同层模块、node: 内置）不在此管控

    // 归一化到绝对路径，再判断落在哪个层目录下
    const abs = resolve(dirname(file), spec);
    for (const { target, why } of FORBIDDEN_TARGETS) {
      const targetDir = join(srcRoot, target);
      if (abs === targetDir || abs.startsWith(`${targetDir}/`)) {
        violations.push(`  ✗ src/${shown}:  import '${spec}'\n      理由：${why}`);
      }
    }
  }
}

for (const v of violations) console.log(v);
console.log(
  violations.length === 0
    ? `  ✓ 分层守卫通过：扫描 ${files.length} 个领域层文件，零越界引用`
    : `  ✗ 分层守卫失败：${violations.length} 处越界引用`,
);
if (violations.length > 0) process.exitCode = 1;
