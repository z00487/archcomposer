/**
 * 生成示例分镜 `public/examples/入口厅堂讲解.storyboard.json`。
 *
 * **为什么需要一个脚本而不是手写一份 JSON**：手写的示例分镜里，构件 ID 与相机位姿
 * 都是编的。一旦模型改了（生成器参数调整、构件增删），示例里就会出现「引用不存在的
 * 构件」——用户的第一印象就是「这个软件坏了」。
 *
 * 用脚本产出，则示例分镜**必然与当前模型一致**：ID 从真实几何里取，机位由真实求解器
 * 算出来。这也是「可复现」这条立场在交付物上的体现——`npm run gen:example` 跑两次
 * 得到逐字节相同的文件（除 meta.updatedAt）。
 *
 * 运行：npm run gen:example
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GeneratedComponent } from '../src/domain/model/generate-hall.ts';
import type { SceneComponent, SceneSummary, TargetRef } from '../src/domain/types/index.ts';
import { IntentKind, defaultPredicatesFor } from '../src/domain/types/intent.ts';
import { createStep, createStoryboard, type Storyboard, type StoryboardStep } from '../src/domain/types/storyboard.ts';
import { addStep, applySolveResult } from '../src/domain/storyboard/storyboard.ts';
import { createDefaultRegistry } from '../src/domain/solver/registry.ts';
import { deriveComponentId, deriveSemantics } from '../src/domain/naming/naming.ts';
import { REPLACEABLE_KINDS } from '../src/domain/types/vocabulary.ts';
import { serializeStoryboard } from '../src/app/io/io.ts';
import { resetIdCounter } from '../src/core/id.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modelPath = join(here, '..', 'public', 'models', 'demohall.geometry.json');
// 允许用命令行参数覆盖输出路径——测试要生成到临时文件里做「重新生成一遍是否一致」的比对
const outPath =
  process.argv[2] ?? join(here, '..', 'public', 'examples', '入口厅堂讲解.storyboard.json');

interface GeometryFile {
  prefix: string;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  components: GeneratedComponent[];
}

const file: GeometryFile = JSON.parse(readFileSync(modelPath, 'utf8'));

const components: SceneComponent[] = file.components.map((c) => ({
  id: deriveComponentId(file.prefix, c.nodeName),
  semantics: deriveSemantics(c.nodeName),
  aabbMin: [...c.aabb.min] as [number, number, number],
  aabbMax: [...c.aabb.max] as [number, number, number],
  visible: true,
  replaceable: REPLACEABLE_KINDS.has(deriveSemantics(c.nodeName).kind),
}));

const scene: SceneSummary = {
  components,
  boundsMin: [...file.bounds.min] as [number, number, number],
  boundsMax: [...file.bounds.max] as [number, number, number],
  aspect: 16 / 9,
  modelPrefix: file.prefix,
};

const registry = createDefaultRegistry();

function find(kind: string, part?: string): SceneComponent | undefined {
  return components.find((c) => c.semantics.kind === kind && (part === undefined || c.semantics.part === part));
}

function single(c: SceneComponent): TargetRef {
  return { form: 'single', component: { id: c.id, semantics: c.semantics } };
}

function relation(a: SceneComponent, b: SceneComponent): TargetRef {
  return {
    form: 'relation',
    from: { id: a.id, semantics: a.semantics },
    to: { id: b.id, semantics: b.semantics },
    relation: 'bear',
  };
}

interface Plan {
  title: string;
  narration: string;
  target: TargetRef;
  kind: IntentKind;
  label: (labelOf: (id: string) => string) => string;
  source: 'demo' | 'manual';
  confidence: number;
  rationale: string;
}

const columnE = find('column', 'e')!;
const columnW = find('column', 'w')!;
const dougongSE = find('dougong', 'se')!;
const purlinE = find('purlin', 'e-front-1') ?? find('purlin')!;
const plinth = find('plinth')!;

const plans: Plan[] = [
  {
    title: '总览：这座厅堂是什么',
    narration: '先看一眼整体：单檐悬山，三开间，坐落在台基上。',
    target: single(plinth),
    kind: IntentKind.ShowOverview,
    label: () => '台基',
    source: 'manual',
    confidence: 1,
    rationale: '由用户手动指定为「总体俯瞰」——讲解从整体开始',
  },
  {
    title: '东侧檐柱',
    narration: '注意这根檐柱：它落在柱础上，柱头承着斗拱。',
    target: single(columnE),
    kind: IntentKind.Emphasize,
    label: () => '东侧檐柱',
    source: 'demo',
    confidence: 0.84,
    rationale: '示范时相机明显靠近该构件，且它被单独高亮',
  },
  {
    title: '斗拱与柱的关系',
    narration: '斗拱坐在柱头上，把上面的荷载传给柱子。',
    target: relation(columnE, dougongSE),
    kind: IntentKind.RevealRelation,
    label: () => '东侧檐柱与东南角斗拱',
    source: 'demo',
    confidence: 0.76,
    rationale: '示范中先后操作了两个构件，且相机取中——像是在说明它们的关系',
  },
  {
    title: '西侧檐柱（同一构图，换目标）',
    narration: '西侧同样是一根檐柱，做法对称。',
    target: single(columnW),
    kind: IntentKind.Emphasize,
    label: () => '西侧檐柱',
    source: 'inherited',
    confidence: 0.84,
    rationale: '由上一步的意图继承而来——重定向时意图不变，只换目标',
  },
  {
    title: '檩条（减少遮挡）',
    narration: '檩条架在梁上。这一步要求「看得见、不挡」——求解器会先找一个本来就看得清的角度，只有找不到时才把挡路的构件调透明。',
    target: single(purlinE),
    kind: IntentKind.ReduceOcclusion,
    label: () => '前檐东段檩条',
    source: 'demo',
    confidence: 0.71,
    rationale: '示范中把遮挡构件调成了半透明，而不是隐藏——保留了空间参照',
  },
];

resetIdCounter();
let board: Storyboard = createStoryboard('入口厅堂讲解');

for (const plan of plans) {
  let step: StoryboardStep = createStep(plan.target, plan.title);
  step = {
    ...step,
    narration: plan.narration,
    intent: {
      id: `intent_${step.id}`,
      kind: plan.kind,
      predicates: defaultPredicatesFor(
        plan.kind,
        plan.target.form === 'relation' ? [plan.target.from.id, plan.target.to.id] : [],
      ),
      provenance: {
        source: plan.source,
        confidence: plan.confidence,
        rationale: plan.rationale,
        confirmedByUser: true,
      },
    },
  };

  board = addStep(board, step);

  // 用真实求解器算机位——示例分镜里的每一条机位都是可复现的计算结果
  const result = registry.solve({ target: plan.target, intent: step.intent!, scene });
  board = applySolveResult(board, step.id, {
    camera: result.camera,
    effects: result.effects,
    note: result.ok
      ? `已求解，保真度 ${Math.round(result.fidelity.overall * 100)}%（${result.evaluated} 个候选）`
      : `求解未通过：${result.conflicts.map((c) => c.note ?? c.measure).join('；')}`,
    ok: result.ok,
  });

  const effectsNote =
    result.effects.transparent.length > 0
      ? `透明 ${result.effects.transparent.length} 件`
      : result.effects.highlight.length > 0
        ? `高亮 ${result.effects.highlight.length} 件`
        : '无特效';
  console.log(
    `  ${result.ok ? '✓' : '✗'} ${plan.title.padEnd(22)} ${plan.kind.padEnd(18)} 保真度 ${
      result.ok ? `${(result.fidelity.overall * 100).toFixed(1)}%` : '—'
    }  ${effectsNote}`,
  );
}

board = {
  ...board,
  modelRef: {
    name: '程序生成厅堂（悬山）',
    componentCount: components.length,
    modelPrefix: file.prefix,
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, serializeStoryboard(board), 'utf8');
console.log();
console.log(`已写出示例分镜：${outPath}`);
console.log(`  ${board.steps.length} 个步骤，${components.length} 个构件的模型`);
