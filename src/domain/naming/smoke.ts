/**
 * 命名规范的冒烟测试（手写断言，不依赖测试框架）。
 *
 * 用途：在没有 vitest 的环境下先验证 §3.1 / §7.1 / §7.2 / §7.3 的实现是否与规范一致。
 * 正式单测待任务四 P1 用 vitest 重写（规范 §10.1 待办 A3）。
 *
 * 运行：node --experimental-strip-types src/domain/naming/smoke.ts
 */
import {
  buildLabel,
  deriveComponentId,
  deriveSemantics,
  isSameKind,
  modelPrefixFromFileName,
  parseNodeName,
  rankReplacementCandidates,
  validateNames,
} from './naming.ts';
import { ComponentKind } from '../types/vocabulary.ts';

/**
 * 本文件只在 Node 下运行，而本工程未装 @types/node（tsconfig 的 types 只有 vite/client）。
 * 这里用**环境声明**取到 process，避免为一个冒烟脚本引入整个 Node 类型包。
 * 声明是纯类型的、可被完全擦除，符合 tsconfig 的 erasableSyntaxOnly。
 */
declare const process: { exitCode?: number };

/** 把失败数回传给 shell（Node 下 process 必然存在；类型声明已收窄） */
function setExitCode(code: number): void {
  process.exitCode = code;
}

let pass = 0;
let fail = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}\n        实际 = ${a}\n        期望 = ${e}`);
  }
}

console.log('\n=== §7.1 模型前缀与 ID ===');
check('demo-hall.glb → demohall', modelPrefixFromFileName('demo-hall.glb'), 'demohall');
check('house.GLB → house', modelPrefixFromFileName('house.GLB'), 'house');
check(
  'ID 形如 prefix@ver/name',
  deriveComponentId('demohall', 'column_e__01'),
  'demohall@1/column_e__01',
);
check(
  '中文文件名走短哈希（确定性）',
  modelPrefixFromFileName('厅堂.glb') === modelPrefixFromFileName('厅堂.glb'),
  true,
);

console.log('\n=== §3.1 语法校验 ===');
check('合法：column_e__01', parseNodeName('column_e__01').wellFormed, true);
check('合法：dougong_se__01', parseNodeName('dougong_se__01').wellFormed, true);
check('合法：purlin_e_front_3', parseNodeName('purlin_e_front_3').wellFormed, true);
check('合法：rafter_e_front__08', parseNodeName('rafter_e_front__08').wellFormed, true);
check('合法：plinth', parseNodeName('plinth').wellFormed, true);
check('非法：含大写', parseNodeName('Dougong_Se_01').wellFormed, false);
check('非法：含中文', parseNodeName('斗拱_东侧_01').wellFormed, false);
check('非法：含连字符', parseNodeName('dougong-se-01').wellFormed, false);
check('非法：Cube.004', parseNodeName('Cube.004').wellFormed, false);

console.log('\n=== §7.2 语义解析（column 无窗面定位）===');
check('column_e__01', deriveSemantics('column_e__01'), {
  kind: 'column',
  part: 'e',
  label: '东侧柱',
});
check('dougong_se__01 → 转角', deriveSemantics('dougong_se__01'), {
  kind: 'dougong',
  part: 'se',
  label: '前檐东转角斗拱',
});
check('dougong_c_front__01 → 柱头', deriveSemantics('dougong_c_front__01'), {
  kind: 'dougong',
  part: 'c-front',
  label: '中央前檐斗拱',
});
check('purlin_e_front_1 → 檐檩（不拼出「檩檩」）', deriveSemantics('purlin_e_front_1'), {
  kind: 'purlin',
  part: 'e-front-1',
  label: '东侧前檐檐檩',
});
check('purlin_c_front_3 → 脊檩', deriveSemantics('purlin_c_front_3'), {
  kind: 'purlin',
  part: 'c-front-3',
  label: '中央前檐脊檩',
});
check('rafter_e_front__08 → 序号不入 part', deriveSemantics('rafter_e_front__08'), {
  kind: 'rafter',
  part: 'e-front',
  label: '东侧前檐椽',
});
check('未知类型 → unknown', deriveSemantics('foo_e__01').kind, ComponentKind.Unknown);
check('label 拼接（转角）', buildLabel(ComponentKind.Dougong, ['nw']), '后檐西转角斗拱');

console.log('\n=== §3.1 单下划线误写序号的宽容恢复 ===');
const wrongly = parseNodeName('column_e_01');
check('单下划线序号被恢复为 sequence', wrongly.sequence, '01');
check('恢复后 part 不含序号', wrongly.locators, ['e']);
check('并给出警告', wrongly.warnings.length > 0, true);
check('语义与合规写法一致', deriveSemantics('column_e_01'), {
  kind: 'column',
  part: 'e',
  label: '东侧柱',
});

console.log('\n=== §7.2 层号越界的宽容策略 ===');
const lenient = parseNodeName('purlin_e_front_9');
check('越界层号不报错但记警告', lenient.warnings.length > 0, true);
check('越界层号仍保留在 part 中', lenient.locators.includes('9'), true);

console.log('\n=== §7.4 重复名阻断 ===');
const report = validateNames('demohall', [
  'column_e__01',
  'column_e__02',
  'column_e__01',
  'plinth',
]);
check('检出重复名', report.duplicates, ['column_e__01']);
const clean = validateNames('demohall', [
  'column_e__01',
  'column_e__02',
  'plinth',
  'ridge',
  'roof_front',
]);
check('无重复时 duplicates 为空', clean.duplicates, []);
check('生成器产出应零警告', clean.warnings, []);

console.log('\n=== §7.3 同类判定 ===');
const dougongSE = deriveSemantics('dougong_se__01');
const dougongSW = deriveSemantics('dougong_sw__01');
const column = deriveSemantics('column_e__01');
const unknown = deriveSemantics('foo_e__01');
check('斗拱 vs 斗拱 → 同类', isSameKind(dougongSE, dougongSW), true);
check('斗拱 vs 柱 → 不同类', isSameKind(dougongSE, column), false);
check('unknown 不参与 → 不同类', isSameKind(dougongSE, unknown), false);

console.log('\n=== §7.3 候选排序（本项目核心用例）===');
const candidates = [
  { id: 'demohall@1/dougong_ne__01', semantics: deriveSemantics('dougong_ne__01') },
  { id: 'demohall@1/dougong_c_front__01', semantics: deriveSemantics('dougong_c_front__01') },
  { id: 'demohall@1/dougong_sw__01', semantics: deriveSemantics('dougong_sw__01') },
  { id: 'demohall@1/dougong_c_back__01', semantics: deriveSemantics('dougong_c_back__01') },
  { id: 'demohall@1/dougong_nw__01', semantics: deriveSemantics('dougong_nw__01') },
];
const ranked = rankReplacementCandidates(dougongSE, candidates);
check('首选 = 对称侧（前檐西转角）', ranked[0].id, 'demohall@1/dougong_sw__01');
check('次选 = 同檐面（前檐柱头），规则 2 优先于规则 3', ranked[1].id,
  'demohall@1/dougong_c_front__01');
check('后檐两个转角紧随其后', ranked.slice(2, 4).map((c) => c.id).sort(), [
  'demohall@1/dougong_ne__01',
  'demohall@1/dougong_nw__01',
]);
check('末位 = 檐面与形态都不同者', ranked[4].id, 'demohall@1/dougong_c_back__01');
console.log('     完整推荐顺序：');
ranked.forEach((c, i) => console.log(`       ${i + 1}. ${c.id}  (${c.semantics.label})`));

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
if (fail > 0) setExitCode(1);
