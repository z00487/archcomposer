/**
 * README「快速开始」五步走查（`npm run walkthrough`）
 *
 * **这个脚本的存在理由**：README 里写了一条五步的操作路径。文档里的路径最容易
 * 悄悄过期——界面上的按钮改了名字、命令层的函数改了签名，README 却还写着老样子，
 * 而且**没有任何测试会失败**（因为没有东西在检查 README）。
 *
 * 本脚本把那条路径在**真实的 86 构件模型**上跑一遍，并断言每一步的结果。
 * 它跑在纯 Node 里（不启浏览器），因为 L3/L4 的核心逻辑本来就不依赖 DOM
 * （约束 C-1）——这正是本项目架构的一个副产品：文档里的操作路径是可以被机器验证的。
 *
 * 它**不能**替代浏览器里的人工走查：DOM 事件绑定、store 订阅的渲染时机、
 * WebGL 上下文创建都测不到（见 docs/04 §12.3）。它只能保证「这条路径的
 * 语义是通的」，不能保证「按钮确实接上了」。
 */
import { readFileSync } from 'node:fs';
import { createAppStores } from '../src/app/stores/stores.ts';
import { createDefaultRegistry } from '../src/domain/solver/registry.ts';
import {
  addStepFromSelection,
  setManualIntent,
  solveStep,
  candidateCandidates,
  redirectStep,
  type CommandContext,
} from '../src/app/commands/commands.ts';
import { IntentKind } from '../src/domain/types/intent.ts';
import { EMPTY_EFFECTS } from '../src/domain/types/solver.ts';
import type { ComponentSemantics } from '../src/domain/types/component.ts';
import type { ComponentId } from '../src/domain/types/component.ts';
import type { SceneSummary } from '../src/domain/types/solver.ts';

const root = new URL('../', import.meta.url).pathname;
const geo = JSON.parse(readFileSync(`${root}public/models/demohall.geometry.json`, 'utf8'));
const sem = JSON.parse(readFileSync(`${root}public/models/demohall.semantics.json`, 'utf8'));

const byNode = new Map<string, ComponentSemantics>(
  sem.components.map((c: { node: string; kind: string; part: string; label: string }) =>
    [c.node, { kind: c.kind, part: c.part, label: c.label } as ComponentSemantics]),
);

const components = geo.components.map((c: { id: string; aabb: { min: number[]; max: number[] } }) => {
  const node = c.id.slice(c.id.indexOf('/') + 1);
  return {
    id: c.id,
    nodeName: node,
    semantics: byNode.get(node)!,
    aabbMin: c.aabb.min,
    aabbMax: c.aabb.max,
    visible: true,
  };
});

const scene: SceneSummary = {
  components,
  boundsMin: geo.bounds.min,
  boundsMax: geo.bounds.max,
  aspect: 1.6,
  modelPrefix: geo.prefix,
};

const idx: Record<ComponentId, ComponentSemantics> = Object.fromEntries(
  components.map((c: { id: string; semantics: ComponentSemantics }) => [c.id, c.semantics]),
);

const stores = createAppStores();
stores.scene.set(() => ({ summary: scene, aspect: scene.aspect }));

const traced: string[] = [];
const ctx: CommandContext = {
  stores,
  registry: createDefaultRegistry(),
  effects: { apply() {}, capture() { return EMPTY_EFFECTS; }, attach() {} } as never,
  refOf: (id: ComponentId) => (idx[id] ? { id, semantics: idx[id] } : null),
  labelOf: (id: ComponentId) => idx[id]?.label ?? id,
  applyCamera() {},
  focusOn() {},
  toast(message: string) {
    traced.push(message);
  },
};

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `　${detail}` : ''}`);
  if (!ok) failures += 1;
}

const START = 'demohall@1/column_e__01';
console.log(`\n模型：${geo.prefix}，${components.length} 个构件\n`);
console.log('README「快速开始」五步走查：\n');

// ① 选构件
stores.selection.set((s) => ({ ...s, selectedId: START }));
check('① 选中构件', stores.selection.get().selectedId === START, START);

// ② 新建步骤
const stepId = addStepFromSelection(ctx);
check('② 用选中构件新建步骤', stepId !== null, stepId ?? '');
if (!stepId) process.exit(1);
const before = stores.storyboard.get().storyboard.steps[0];
check('   新步骤的目标就是所选构件', before.target.form === 'single' && before.target.component.id === START);
check('   新步骤默认未求解', before.solve === 'none');

// ③ 设意图
setManualIntent(ctx, stepId, IntentKind.Emphasize as never);
const withIntent = stores.storyboard.get().storyboard.steps[0];
check('③ 设置意图', withIntent.intent?.kind === IntentKind.Emphasize, String(withIntent.intent?.kind));

// ④ 求解
solveStep(ctx, stepId);
const solved = stores.storyboard.get().storyboard.steps[0];
const cameraBefore = JSON.stringify(solved.camera);
const fidelityBefore = solved.camera ? 1 : 0;
check('④ 求解成功', solved.solve === 'solved' && solved.camera !== null);
check('   解出机位', solved.camera !== null,
  solved.camera ? solved.camera.position.map((v) => v.toFixed(2)).join(', ') : '');
const intentSnapshot = JSON.stringify(solved.intent);
check('   意图快照已取（用于第 ⑤ 步对比）', intentSnapshot.length > 0, `保真度基准 ${fidelityBefore === 1 ? '可用' : '不可用'}`);

// ⑤ 换同类构件并重解
const candidates = candidateCandidates(ctx, stepId);
check('⑤ 找到可换的同类构件', candidates.length > 0, `共 ${candidates.length} 个：${candidates.slice(0, 3).join(' | ')} …`);
const picked = candidates[0];
const result = redirectStep(ctx, stepId, { form: 'single', component: { id: picked, semantics: idx[picked] } });
const redirected = stores.storyboard.get().storyboard.steps[0];

check('   换目标成功', redirected.target.form === 'single' && redirected.target.component.id === picked, picked);
check('   重定向保真度达标', result.ok && result.fidelity >= 0.65, `${(result.fidelity * 100).toFixed(1)}%`);
check('★ 意图逐字段未变', JSON.stringify(redirected.intent) === intentSnapshot);
check('★ 机位确实重解了', cameraBefore !== JSON.stringify(redirected.camera),
  redirected.camera ? redirected.camera.position.map((v) => v.toFixed(2)).join(', ') : '');

// 顺带把命令层给用户看的提示打出来——它们本身也是「这条路径通畅」的证据
console.log(`\n命令层给用户的提示（${traced.length} 条）：`);
for (const t of traced) console.log(`  · ${t}`);

console.log(`\n${failures === 0 ? '✓ 五步全通' : `✗ ${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
