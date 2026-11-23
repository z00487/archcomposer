/**
 * 生成器的机械化自检（对应 `npm run smoke:generate`）
 *
 * **它存在的理由与 `walkthrough.ts` 相同**：把「生成」这条链路上最容易悄悄坏掉的
 * 事写死成断言，让 `npm run verify` 能抓到。具体检查四件事：
 *
 *  1. **离线生成从不依赖网络**：在没有任何环境变量、不发起请求的情况下能跑通
 *     （这是「断网也能演示」的保证）；
 *  2. **输出确定**：同一个请求跑两次，结果逐字节相同（生成结果进了回归链，
 *     一旦有人加了随机或时间依赖，这里立刻红）；
 *  3. **绝不引用不存在的构件**：草稿里每个 ID 都能在真实模型里找到——
 *     这是全链路最关键的一条不变量；
 *  4. **模型胡编时会被挡住**：喂给 LLM 生成器一份「构件 ID 全是假的」的响应，
 *     验证它把这些步骤全部丢弃并记 warning，而不是把悬空引用放进分镜。
 *
 * 运行：node --experimental-strip-types scripts/smoke-generate.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateRuleDraft, RuleStoryboardGenerator, toGenerationComponents, scanKnowledge, planKnowledge, KNOWLEDGE_BASE } from '../src/domain/generator/knowledge.ts';
import { LlmStoryboardGenerator, extractJson, normalizeDraft, buildSystemPrompt } from '../src/domain/generator/llm-generator.ts';
import type { GenerationRequest } from '../src/domain/generator/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const modelPath = resolve(join(here, '..', 'public', 'models', 'demohall.geometry.json'));

interface GeometryFile {
  prefix: string;
  components: Array<{ id: string; nodeName: string; semantics: { kind: string; part: string; label: string } }>;
}

const geo = JSON.parse(readFileSync(modelPath, 'utf8')) as GeometryFile;
const components = toGenerationComponents(
  geo.components.map((c) => ({ id: c.id, semantics: c.semantics, visible: true })),
);

let problems = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => { problems += 1; console.log(`  ✗ ${msg}`); };

console.log('\n生成器自检（npm run smoke:generate）\n');

// ── ① 知识表自身的完整性 ───────────────────────────────────────

console.log('① 知识表完整性');
{
  const names = new Set<string>();
  for (const entry of KNOWLEDGE_BASE) {
    if (names.has(entry.name)) bad(`知识点名重复：${entry.name}`);
    names.add(entry.name);
    if (entry.words.length === 0) bad(`知识点「${entry.name}」没有指代词，永远不会被命中`);
    if (entry.kinds.length === 0) bad(`知识点「${entry.name}」没有承载构件类型`);
    if (entry.narration.length < 8) bad(`知识点「${entry.name}」的旁白过短`);
  }
  if (problems === 0) ok(`${KNOWLEDGE_BASE.length} 个知识点，名称唯一、指代词非空`);
}

// ── ② 真实模型上离线生成，且不引用不存在的构件 ─────────────────

console.log('\n② 离线生成 + 构件引用有效性');
const goal = '给第一次参观的游客做一个 3 分钟讲解，重点介绍整体结构、屋顶和斗拱';
const request: GenerationRequest = {
  goal,
  audience: '第一次参观的游客',
  targetDurationMs: 180000,
  components,
  modelPrefix: geo.prefix,
};

{
  const draft = generateRuleDraft(request);
  if (draft.steps.length === 0) bad('离线生成没有产出任何步骤');
  else ok(`生成 ${draft.steps.length} 步：${draft.steps.map((s) => s.title).join(' → ')}`);

  const ids = new Set(components.map((c) => c.id));
  let dangling = 0;
  for (const step of draft.steps) {
    if (!ids.has(step.targetId)) { bad(`步骤「${step.title}」引用了不存在的构件 ${step.targetId}`); dangling += 1; }
    if (step.partnerId && !ids.has(step.partnerId)) { bad(`步骤「${step.title}」的关系端引用了不存在的构件 ${step.partnerId}`); dangling += 1; }
  }
  if (dangling === 0) ok(`${draft.steps.length} 步的目标构件全部真实存在于模型（共 ${ids.size} 个构件）`);

  const total = draft.steps.reduce((s, x) => s + x.durationMs, 0);
  ok(`总时长约 ${Math.round(total / 1000)} 秒（要求 180 秒）`);
}

// ── ③ 确定性：同一个请求两次结果相同 ────────────────────────────

console.log('\n③ 输出确定性');
{
  const a = JSON.stringify(generateRuleDraft(request));
  const b = JSON.stringify(generateRuleDraft(request));
  if (a === b) ok('同一请求两次生成，输出逐字节相同');
  else bad('两次生成的结果不同——生成器里混进了随机或时间依赖');
}

// ── ④ 命中顺序尊重作者 ─────────────────────────────────────────

console.log('\n④ 目标文本 → 知识点顺序');
{
  const hits = scanKnowledge('先讲斗拱，再讲屋顶');
  const order = hits.map((h) => h.entry.name);
  if (order[0] === '斗拱' && order[1] === '屋顶') ok(`按作者说的先后命中：${order.join(' → ')}`);
  else bad(`顺序不对，实际是 ${order.join(' → ')}`);

  const planned = planKnowledge('屋顶和斗拱').map((e) => e.name);
  if (planned.includes('屋顶') && planned.includes('斗拱')) ok(`规划结果包含两个知识点：${planned.join(' → ')}`);
  else bad(`规划结果不对：${planned.join(' → ')}`);

  const fallback = planKnowledge('').map((e) => e.name);
  if (fallback.length > 0) ok(`空目标有默认讲解：${fallback.join(' → ')}`);
  else bad('空目标没有默认讲解');
}

// ── ⑤ LLM 输出的健壮性（全部离线模拟，不联网）──────────────────

console.log('\n⑤ LLM 输出的校验与降级（模拟响应）');
{
  // Markdown 包裹
  const fenced = extractJson('```json\n{"title":"x","steps":[]}\n```');
  if (fenced && (fenced as { title: string }).title === 'x') ok('能从 ```json 代码块里抠出 JSON');
  else bad('剥 Markdown 代码块失败');

  // 前后有解释文字
  const noisy = extractJson('好的，这是结果：{"title":"y","steps":[]} 希望有帮助！');
  if (noisy && (noisy as { title: string }).title === 'y') ok('能从前后有解释文字的响应里抠出 JSON');
  else bad('从噪声里抠 JSON 失败');

  // ★ 模型编造构件 ID → 整步丢弃
  const fake = normalizeDraft(
    {
      title: '模型胡编的结果',
      steps: [
        { title: '假构件', narration: '这一段讲不存在的东西', targetId: 'demohall@1/不存在的构件', intentKind: 'EMPHASIZE', durationMs: 4000 },
        { title: '真构件', narration: '这一段讲斗拱', targetId: 'demohall@1/dougong_se__01', intentKind: 'EMPHASIZE', durationMs: 4000 },
      ],
    },
    request,
    'test',
  );
  if (fake.steps.length === 1 && fake.steps[0].targetId === 'demohall@1/dougong_se__01') {
    ok('★ 编造的构件 ID 被丢弃，真实的那一步保留');
  } else {
    bad(`编造构件的过滤失效：剩下 ${fake.steps.length} 步`);
  }
  if (fake.warnings.length > 0) ok(`丢弃时如实记了 warning：${fake.warnings[0].slice(0, 40)}…`);
  else bad('丢弃步骤时没有记 warning——这是静默降级');

  // 非法意图类型 → 退回 EMPHASIZE 并记 warning
  const badIntent = normalizeDraft(
    { steps: [{ targetId: 'demohall@1/dougong_se__01', intentKind: '认真讲一下', durationMs: 4000 }] },
    request,
    'test',
  );
  if (badIntent.steps[0]?.intentKind === 'EMPHASIZE' && badIntent.warnings.length > 0) ok('非法意图类型退回「强调」并记 warning');
  else bad('非法意图类型没有被妥善处理');

  // 缺旁白 → 用构件名兜底，不留空串
  const noNarration = normalizeDraft(
    { steps: [{ targetId: 'demohall@1/dougong_se__01', intentKind: 'EMPHASIZE', durationMs: 4000 }] },
    request,
    'test',
  );
  if (noNarration.steps[0]?.narration.trim().length > 0) ok(`缺旁白时用构件名兜底：「${noNarration.steps[0].narration}」`);
  else bad('缺旁白时留了空字符串（播放时会是静默）');
}

// ── ⑥ LLM 不可用 / 乱回话时的两条路径 ──────────────────────────

console.log('\n⑥ LLM 失败的两种降级路径');
{
  // (a) 网络失败 → 回退到离线知识表
  const offlineLlm = new LlmStoryboardGenerator(async () => ({ ok: false, text: '', error: '测试用的网络失败' }), 'test');
  const fellBack = await offlineLlm.generate(request);
  if (fellBack.steps.length > 0 && fellBack.generator === 'rule-kb-v1') {
    ok(`网络失败 → 回退到离线生成（${fellBack.steps.length} 步），并说明原因：${fellBack.notes[0].slice(0, 30)}…`);
  } else {
    bad(`网络失败时没有回退到离线生成（generator=${fellBack.generator}, steps=${fellBack.steps.length}）`);
  }

  // (b) 返回合法 JSON 但 ID 全是假的 → **不回退**，把问题暴露出来
  const lyingLlm = new LlmStoryboardGenerator(
    async () => ({ ok: true, text: JSON.stringify({ steps: [{ targetId: '假ID', narration: 'x', intentKind: 'EMPHASIZE' }] }) }),
    'test',
  );
  const lied = await lyingLlm.generate(request);
  if (lied.steps.length === 0 && lied.warnings.length > 0) {
    ok('★ 模型全部编造时**不回退**，而是显式报出问题（避免「悄悄换了结果」）');
  } else {
    bad(`模型全部编造时的行为不符合预期（steps=${lied.steps.length}）`);
  }
}

// ── ⑦ 提示词里带着真实构件清单 ─────────────────────────────────

console.log('\n⑦ 提示词');
{
  const sys = buildSystemPrompt();
  if (sys.includes('不能编造') || sys.includes('不能编')) ok('系统提示词明确禁止编造构件 ID');
  else bad('系统提示词没有禁止编造构件 ID');

  const generator = new RuleStoryboardGenerator();
  if (generator.requiresNetwork === false) ok('规则生成器标注为「不需要网络」');
  else bad('规则生成器错误地标注为需要网络');
}

console.log(
  problems === 0
    ? '\n✓ 生成器自检全部通过\n'
    : `\n✗ 生成器自检发现 ${problems} 个问题\n`,
);
if (problems > 0) process.exitCode = 1;
