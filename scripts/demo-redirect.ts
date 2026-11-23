/**
 * 端到端演示脚本：用**真实的生成模型**跑一遍意图保持重定向。
 *
 * 这是给论文 E1 评估准备的最小可复现的「证据生成器」。它做四件事：
 *   ① 读入 public/models/demohall.geometry.json（86 个构件的程序生成厅堂）
 *   ② 把几何描述翻译成领域层的 SceneSummary（**不经过 three**）
 *   ③ 对若干组「目标替换 × 意图类型」跑重定向
 *   ④ 打印保真度表格
 *
 * 运行：node --experimental-strip-types scripts/demo-redirect.ts
 *     或 npm run demo:redirect
 *
 * **为什么不用 app/commands/commands.ts 的 redirectStep**：那个版本需要
 * Viewport / EffectManager 等 L2、L4 对象。本脚本存在的意义正是要证明
 * **「重定向的核心逻辑不需要这些」**（约束 C-1）——它跑在纯 Node 里。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GeneratedComponent } from '../src/domain/model/generate-hall.ts';
import type { SceneComponent, SceneSummary, TargetRef, VisualIntent } from '../src/domain/types/index.ts';
import { IntentKind } from '../src/domain/types/index.ts';
import { defaultPredicatesFor } from '../src/domain/types/intent.ts';
import { createDefaultRegistry } from '../src/domain/solver/registry.ts';
import { rankReplacementCandidates } from '../src/domain/naming/naming.ts';
import { deriveComponentId, deriveSemantics, isSameKind } from '../src/domain/naming/naming.ts';
import { evaluateRedirectionFidelity } from '../src/domain/fidelity/fidelity.ts';
import { computeContextIds } from '../src/domain/solver/context.ts';
import { REPLACEABLE_KINDS } from '../src/domain/types/vocabulary.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modelPath = join(here, '..', 'public', 'models', 'demohall.geometry.json');

interface GeometryFile {
  schemaVersion: number;
  prefix: string;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  components: GeneratedComponent[];
}

/** 从几何描述构造领域层的场景摘要（**不经过 three**）。 */
function toSceneSummary(file: GeometryFile, aspect: number): SceneSummary {
  const components: SceneComponent[] = file.components.map((c) => ({
    id: deriveComponentId(file.prefix, c.nodeName),
    semantics: deriveSemantics(c.nodeName),
    aabbMin: [...c.aabb.min] as [number, number, number],
    aabbMax: [...c.aabb.max] as [number, number, number],
    visible: true,
    replaceable: REPLACEABLE_KINDS.has(deriveSemantics(c.nodeName).kind),
  }));
  return {
    components,
    boundsMin: [...file.bounds.min] as [number, number, number],
    boundsMax: [...file.bounds.max] as [number, number, number],
    aspect,
    modelPrefix: file.prefix,
  };
}

function intentFor(kind: IntentKind, subjects: string[]): VisualIntent {
  return {
    id: `demo_${kind}`,
    kind,
    predicates: defaultPredicatesFor(kind, subjects),
    provenance: { source: 'manual', confidence: 1, rationale: '演示脚本构造', confirmedByUser: true },
  };
}

function singleTarget(scene: SceneSummary, id: string): TargetRef {
  const component = scene.components.find((c) => c.id === id)!;
  return { form: 'single', component: { id: component.id, semantics: component.semantics } };
}

function relationTarget(scene: SceneSummary, fromId: string, toId: string): TargetRef {
  const from = scene.components.find((c) => c.id === fromId)!;
  const to = scene.components.find((c) => c.id === toId)!;
  return {
    form: 'relation',
    from: { id: from.id, semantics: from.semantics },
    to: { id: to.id, semantics: to.semantics },
    relation: 'bear',
  };
}

// ── 主流程 ─────────────────────────────────────────────────────

const file: GeometryFile = JSON.parse(readFileSync(modelPath, 'utf8'));
const scene = toSceneSummary(file, 16 / 9);
const registry = createDefaultRegistry();

console.log(`模型：${file.prefix}，${file.components.length} 个构件`);
console.log(`求解器：${registry.defaultSolverName}`);
console.log();

/** 跑一次重定向，返回保真度等指标。 */
function redirect(
  target: TargetRef,
  nextTarget: TargetRef,
  kind: IntentKind,
  seedFrom: TargetRef,
): { ok: boolean; fidelity: number; consistency: number; ms: number; conflicts: number } {
  const subjects = nextTarget.form === 'relation'
    ? [nextTarget.from.id, nextTarget.to.id]
    : [];
  const intent = intentFor(kind, subjects);

  // 先用原目标解一次，得到「重定向前」的位姿（模拟作者已经调好的那一步）
  const before = registry.solve({ target: seedFrom, intent, scene, maxCandidates: 640 });
  const start = performance.now();
  const after = registry.solve({
    target: nextTarget,
    intent,
    scene,
    seed: before.camera,
    maxCandidates: 640,
  });
  const ms = performance.now() - start;

  let fidelity = after.fidelity.overall;
  let consistency = 1;
  if (before.camera && after.camera) {
    const contextIds = computeContextIds(nextTarget, scene);
    const evaluation = evaluateRedirectionFidelity(
      { pose: before.camera, effects: before.effects, target: seedFrom },
      { pose: after.camera, effects: after.effects, target: nextTarget },
      intent,
      scene,
      contextIds,
    );
    fidelity = evaluation.overall;
    consistency = evaluation.consistency;
  }

  return { ok: after.ok, fidelity, consistency, ms, conflicts: after.conflicts.length };
}

// 选几个有代表性的目标组合
const columns = scene.components.filter((c) => c.semantics.kind === 'column');
const dougongs = scene.components.filter((c) => c.semantics.kind === 'dougong');
const purlins = scene.components.filter((c) => c.semantics.kind === 'purlin');

const cases: Array<{ label: string; from: TargetRef; to: TargetRef; kind: IntentKind }> = [];

if (columns.length >= 2) {
  cases.push({
    label: `柱 ${columns[0].semantics.part} → 柱 ${columns[1].semantics.part}`,
    from: singleTarget(scene, columns[0].id),
    to: singleTarget(scene, columns[1].id),
    kind: IntentKind.Emphasize,
  });
  cases.push({
    label: `柱（对称换）`,
    from: singleTarget(scene, columns[0].id),
    to: singleTarget(scene, columns[columns.length - 1].id),
    kind: IntentKind.Emphasize,
  });
}
if (dougongs.length >= 2) {
  cases.push({
    label: `斗拱 ${dougongs[0].semantics.part} → 斗拱 ${dougongs[1].semantics.part}`,
    from: singleTarget(scene, dougongs[0].id),
    to: singleTarget(scene, dougongs[1].id),
    kind: IntentKind.Emphasize,
  });
}
if (purlins.length >= 2) {
  cases.push({
    label: `檩 ${purlins[0].semantics.part} → 檩 ${purlins[1].semantics.part}`,
    from: singleTarget(scene, purlins[0].id),
    to: singleTarget(scene, purlins[1].id),
    kind: IntentKind.Emphasize,
  });
  cases.push({
    label: `檩（俯瞰）`,
    from: singleTarget(scene, purlins[0].id),
    to: singleTarget(scene, purlins[1].id),
    kind: IntentKind.ShowOverview,
  });
}
if (columns.length >= 1 && purlins.length >= 1) {
  cases.push({
    label: `柱 + 檩（揭示关系）`,
    from: relationTarget(scene, columns[0].id, purlins[0].id),
    to: relationTarget(scene, columns[1 % columns.length].id, purlins[1 % purlins.length].id),
    kind: IntentKind.RevealRelation,
  });
}

console.log('目标替换'.padEnd(28) + '意图'.padEnd(18) + '通过  保真度  一致性  耗时  冲突');
console.log('-'.repeat(90));
for (const c of cases) {
  const r = redirect(c.to, c.to, c.kind, c.from);
  const pass = r.ok ? ' ✓ ' : ' ✗ ';
  console.log(
    c.label.padEnd(28) +
    c.kind.padEnd(18) +
    pass +
    (r.fidelity * 100).toFixed(1).padStart(6) + '%  ' +
    (r.consistency * 100).toFixed(1).padStart(6) + '%  ' +
    r.ms.toFixed(0).padStart(5) + 'ms' +
    String(r.conflicts).padStart(4),
  );
}
