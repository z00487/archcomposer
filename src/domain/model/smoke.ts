/**
 * 生成器的自检（规范 §8.5 的四条验收条件）。
 *
 * 运行：node --experimental-strip-types src/domain/model/smoke.ts
 */
import { DEFAULT_HALL_PARAMS, generateHall } from './generate-hall.ts';
import { deriveSemantics, validateNames } from '../naming/naming.ts';

declare const process: { exitCode?: number };

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

const model = generateHall();
const names = model.components.map((c) => c.nodeName);

console.log('\n=== §8.5 验收 1：阻断类校验全部通过 ===');
const report = validateNames(model.prefix, names);
check('无重复名', report.duplicates, []);

console.log('\n=== §8.5 验收 2：警告数为 0 ===');
check('零警告', report.warnings, []);

console.log('\n=== §8.5 验收 3：构件总量级（§2.3 要求 80~140）===');
check('总数 = 86', model.components.length, 86);
check('总量在 80~140 内', model.components.length >= 80 && model.components.length <= 140, true);

console.log('\n=== §8.5 验收 4：名字解析的语义与生成时的语义一致 ===');
let mismatch = 0;
for (const c of model.components) {
  const re = deriveSemantics(c.nodeName);
  if (JSON.stringify(re) !== JSON.stringify(c.semantics)) {
    mismatch++;
    console.log(`     不一致：${c.nodeName} → ${JSON.stringify(re)}`);
  }
}
check('零不一致', mismatch, 0);

console.log('\n=== 逐类计数（规范 §9.1 的节点树）===');
const count = (prefix: string) => names.filter((n) => n === prefix || n.startsWith(prefix)).length;
const byKind: Record<string, number> = {};
for (const c of model.components) {
  byKind[c.semantics.kind] = (byKind[c.semantics.kind] ?? 0) + 1;
}
console.log('    ', JSON.stringify(byKind));
check('柱 8', byKind['column'], 8);
check('柱础 8', byKind['columnbase'], 8);
check('斗拱 8', byKind['dougong'], 8);
check('梁 6', byKind['beam'], 6);
check('檩 18', byKind['purlin'], 18);
check('椽 32', byKind['rafter'], 32);
check('台基 1', byKind['plinth'], 1);
check('正脊 1', byKind['ridge'], 1);
check('屋面 2', byKind['roof'], 2);
check('山墙 2', byKind['gable'], 2);
check('unknown 为 0', byKind['unknown'] ?? 0, 0);
void count;

console.log('\n=== §4.11 关键命名规则 ===');
check('无「东端柱头斗拱」', names.includes('dougong_e_front__01'), false);
check('无「西端柱头斗拱」', names.includes('dougong_w_front__01'), false);
check('序号用双下划线', names.includes('column_e__01') && names.includes('rafter_e_front__08'), true);
check('层号用单下划线', names.includes('purlin_e_front_1') && !names.includes('purlin_e_front__1'), true);
check('檩的 3 层齐备', ['purlin_e_front_1', 'purlin_e_front_2', 'purlin_e_front_3']
  .every((n) => names.includes(n)), true);
check('转角斗拱 4 攒', ['dougong_se__01', 'dougong_sw__01', 'dougong_ne__01', 'dougong_nw__01']
  .every((n) => names.includes(n)), true);
check('柱头斗拱 4 攒', ['dougong_c_front__01', 'dougong_c_front__02',
  'dougong_c_back__01', 'dougong_c_back__02'].every((n) => names.includes(n)), true);
check('表内无未登记类型', names.every((n) => !n.startsWith('foo')), true);

console.log('\n=== §2.3 尺寸量级 ===');
const [minB, maxB] = [model.bounds.min, model.bounds.max];
const width = maxB[0] - minB[0];
const depthExtent = maxB[2] - minB[2];
const ridgeTop = maxB[1];
const colSpan = model.columnXs[model.columnXs.length - 1] - model.columnXs[0];
console.log(
  `     柱距总宽 ${colSpan.toFixed(2)} m，含出檐总宽 ${width.toFixed(2)} m；` +
    `柱距进深 ${model.params.depth.toFixed(2)} m，含出檐 ${depthExtent.toFixed(2)} m；` +
    `最高点 ${ridgeTop.toFixed(2)} m`,
);
check('柱距总宽 9~14 m', colSpan >= 9 && colSpan <= 14, true);
check('含出檐总宽 9~15 m', width >= 9 && width <= 15, true);
check('柱距进深 = 6.0（§8.2 默认值）', model.params.depth, 6.0);
check('含出檐进深 ≤ 9 m（不得让梁穿出屋面）', depthExtent <= 9, true);
check('最高点（正脊）6~8 m', ridgeTop >= 6 && ridgeTop <= 8, true);

console.log('\n=== §8.4 约束 4：几何中心与原点（§2.2）===');
const plinth = model.components.find((c) => c.nodeName === 'plinth')!;
check('台基顶面 = y 0', plinth.aabb.max[1], 0);
check('台基底面 = -0.45', plinth.aabb.min[1], -0.45);
check('柱础底面 = y 0', (() => {
  const cb = model.components.find((c) => c.nodeName === 'columnbase_e__01')!;
  return cb.aabb.min[1];
})(), 0);
check('东南角柱 Z 为正（+Z 南）',
  model.components.find((c) => c.nodeName === 'column_e__01')!.position[2] > 0, true);
check('东北角柱 Z 为负（-Z 北）',
  model.components.find((c) => c.nodeName === 'column_e__02')!.position[2] < 0, true);
check('东山墙 X 为正（+X 东）',
  model.components.find((c) => c.nodeName === 'gable_e')!.position[0] > 0, true);
check('构件整体关于原点 X 对称',
  Math.abs(minB[0] + maxB[0]) < 1e-9, true);
check('无构件穿出屋面（梁不得超出屋面下沿）', (() => {
  const roofZ = Math.max(
    ...model.components.filter((c) => c.nodeName.startsWith('roof_')).map((c) => Math.abs(c.aabb.max[2])),
  );
  return model.components
    .filter((c) => c.nodeName.startsWith('beam_'))
    .every((c) => Math.abs(c.aabb.max[2]) <= roofZ);
})(), true);

console.log('\n=== §8.4 约束 1：确定性（同参数必得同结果）===');
const again = generateHall();
check('构件序列化完全一致',
  JSON.stringify(again.components) === JSON.stringify(model.components), true);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
if (fail > 0) process.exitCode = 1;
void DEFAULT_HALL_PARAMS;
