/**
 * 生成链路的编排测试（答辩 PPT 第 3 页「01 生成」、开题报告 §3.2）
 *
 * **这个文件补的是生成这条链路上最容易出错的地方：接缝。**
 *
 * `smoke-generate.ts` 已经把「生成器本身」测透了（知识表完整性、确定性、
 * 不引用不存在的构件、LLM 输出校验与降级）。但真正会出事的地方在**接缝处**：
 *
 *  - 草稿里的 `intentKind` 有没有真的变成一份**可求解的意图**（谓词对不对）；
 *  - 生成出来的步骤有没有**就地求解**（否则作者点完生成看到一堆「未求解」）；
 *  - 生成是否**追加**而不覆盖已有内容；
 *  - 求解失败的步骤有没有**留在分镜里并标明**，而不是悄悄少一步（FR-19）；
 *  - 「不要隐藏柱子」这类否定式指令，经过语言通道之后**到底写进了哪里**。
 *
 * 这些都在 L4（`adoptDraft` / `applyInstructions`），用假的 CommandContext 跑，
 * 不需要浏览器、不需要网络、不需要 API key。
 */
import { describe, expect, it } from 'vitest';

import {
  adoptDraft,
  applyFeedback,
  applyInstructions,
  setStepMotion,
  solveStep,
  addStepFromSelection,
  setManualIntent,
  stepSummaries,
  type CommandContext,
} from '../app/commands/commands.ts';
import { createAppStores } from '../app/stores/stores.ts';
import { createDefaultRegistry } from '../domain/solver/registry.ts';
import { testScene } from './fixtures.ts';
import type { SceneSummary, VisualEffects } from '../domain/types/solver.ts';
import { EMPTY_EFFECTS } from '../domain/types/solver.ts';
import { resetIdCounter } from '../core/id.ts';
import { generateRuleDraft, scanKnowledge, planKnowledge } from '../domain/generator/knowledge.ts';
import { toGenerationComponents } from '../domain/generator/knowledge.ts';
import type { GenerationRequest } from '../domain/generator/types.ts';
import { parseEditInstruction } from '../domain/language/instructions.ts';
import { diagnoseFeedback } from '../domain/language/feedback.ts';
import { IntentKind } from '../domain/types/intent.ts';
import { generateDraft } from '../app/generate/generate.ts';
import { normalizeLlmSettings, loadLlmSettings, saveLlmSettings } from '../app/llm/settings-store.ts';
import { LlmStoryboardGenerator } from '../domain/generator/llm-generator.ts';
import type { ComponentId } from '../domain/types/component.ts';

const SCENE: SceneSummary = testScene(1.6);

interface Harness {
  ctx: CommandContext;
  toasts: string[];
  appliedEffects: VisualEffects[];
}

function harness(scene: SceneSummary = SCENE): Harness {
  resetIdCounter();
  const stores = createAppStores();
  const index = Object.fromEntries(scene.components.map((c) => [c.id, c.semantics]));
  stores.scene.set(() => ({ summary: scene }));

  const toasts: string[] = [];
  const appliedEffects: VisualEffects[] = [];

  const ctx: CommandContext = {
    stores,
    registry: createDefaultRegistry(),
    effects: {
      apply: (effects: VisualEffects) => appliedEffects.push(effects),
      capture: () => EMPTY_EFFECTS,
      attach: () => ({}),
    } as never,
    refOf: (id) => (index[id] ? { id, semantics: index[id] } : null),
    labelOf: (id) => (index[id] ? `${index[id].kind} ${index[id].part}`.trim() : id),
    applyCamera: () => {},
    focusOn: () => {},
    toast: (message) => {
      toasts.push(message);
    },
  };

  return { ctx, toasts, appliedEffects };
}

/** 造一份「目标构件只包含夹具场景里真实存在的那些」的请求。 */
function requestFor(goal: string, durationMs: number | null = 60000): GenerationRequest {
  return {
    goal,
    audience: '第一次参观的游客',
    targetDurationMs: durationMs,
    components: toGenerationComponents(SCENE.components.map((c) => ({
      id: c.id,
      semantics: c.semantics,
      visible: c.visible,
    }))),
    modelPrefix: SCENE.modelPrefix,
  };
}

const stepsOf = (h: Harness) => h.ctx.stores.storyboard.get().storyboard.steps;

// ── 草稿 → 步骤（`adoptDraft`）───────────────────────────────

describe('把生成草稿落成分镜', () => {
  it('★ 生成结果会把意图真的装进步骤，并就地求解出机位', () => {
    const h = harness();
    const draft = generateRuleDraft(requestFor('讲一下整体和屋顶'));
    expect(draft.steps.length).toBeGreaterThan(0);

    const outcome = adoptDraft(h.ctx, draft);
    expect(outcome.created).toBe(draft.steps.length);

    for (const step of stepsOf(h)) {
      expect(step.intent).not.toBeNull();
      // ★ 「生成了可播放的一版」是作者点这个按钮的全部预期。
      //   若这里解不出来，界面上会是「已生成 N 步，0 步已求解」——那就等于没生成。
      expect(step.solve).toBe('solved');
      expect(step.camera).not.toBeNull();
      expect(step.narration.length).toBeGreaterThan(0);
    }
  });

  it('生成是**追加**，不会清掉作者已经编好的步骤', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const mine = addStepFromSelection(h.ctx)!;
    setManualIntent(h.ctx, mine, IntentKind.Emphasize);

    const draft = generateRuleDraft(requestFor('讲一下屋顶'));
    adoptDraft(h.ctx, draft);

    const ids = stepsOf(h).map((s) => s.id);
    expect(ids[0]).toBe(mine);
    expect(ids.length).toBe(1 + draft.steps.length);
  });

  it('生成器给出的意图类型原样落到步骤上（不被吞成默认值）', () => {
    const h = harness();
    const draft = generateRuleDraft(requestFor('讲一下整体和屋顶'));
    adoptDraft(h.ctx, draft);
    const kinds = stepsOf(h).map((s) => s.intent!.kind);
    expect(kinds).toEqual(draft.steps.map((s) => s.intentKind));
  });

  it('草稿里的运镜角度会变成步骤上的环绕运镜', () => {
    const h = harness();
    const draft = generateRuleDraft(requestFor('讲一下整体和屋顶'));
    const withMotion = draft.steps.findIndex((s) => (s.motionDegrees ?? 0) !== 0);
    if (withMotion < 0) return; // 这一版知识表没给出环绕要求，跳过
    adoptDraft(h.ctx, draft);
    expect(stepsOf(h)[withMotion].motion?.degrees).toBe(draft.steps[withMotion].motionDegrees);
  });

  it('★ 目标构件不在模型里的草稿步会被跳过并如实说明，而不是硬塞进去', () => {
    const h = harness();
    const draft = generateRuleDraft(requestFor('讲一下屋顶'));
    const tampered = {
      ...draft,
      steps: [...draft.steps, { ...draft.steps[0], title: '幽灵步骤', targetId: 'hall@1/不存在' as ComponentId }],
    };
    const outcome = adoptDraft(h.ctx, tampered);
    expect(outcome.created).toBe(draft.steps.length);
    expect(outcome.skipped).toBe(1);
    expect(outcome.needsAttention).toBe(true);
    expect(outcome.messages.some((m) => m.includes('幽灵步骤'))).toBe(true);
    // 悬空引用绝不能进分镜：它会在播放时崩在离病因很远的地方
    expect(stepsOf(h).some((s) => s.target.form === 'single' && s.target.component.id === 'hall@1/不存在')).toBe(false);
  });

  it('场景未就绪时生成被拒绝，且给出明确原因', () => {
    const h = harness();
    h.ctx.stores.scene.set(() => ({ summary: null }));
    const outcome = adoptDraft(h.ctx, generateRuleDraft(requestFor('讲一下屋顶')));
    expect(outcome.created).toBe(0);
    expect(h.toasts.at(-1)).toContain('场景尚未就绪');
  });

  it('采纳草稿后选中的是最后一步，作者能立刻看到结果', () => {
    const h = harness();
    const draft = generateRuleDraft(requestFor('讲一下屋顶'));
    adoptDraft(h.ctx, draft);
    const state = h.ctx.stores.storyboard.get();
    expect(state.activeStepId).toBe(stepsOf(h).at(-1)!.id);
  });
});

// ── 离线 / 在线两条通道的选择（`generateDraft`）────────────────

describe('生成通道的选择与降级', () => {
  const deps = () => ({
    scene: () => SCENE,
    settings: () => normalizeLlmSettings({ model: 'deepseek-chat' }),
  });

  it('没勾大模型时走离线知识表，且标注来源', async () => {
    const out = await generateDraft({ goal: '讲一下屋顶', audience: '', minutes: 1, useLlm: false }, deps());
    expect(out.usedLlm).toBe(false);
    expect(out.source).toBe('离线知识表');
    expect(out.draft.steps.length).toBeGreaterThan(0);
  });

  it('★ 勾了大模型但请求失败时，回退到离线生成并说明原因（不是抛错空白）', async () => {
    const out = await generateDraft(
      { goal: '讲一下屋顶', audience: '', minutes: 1, useLlm: true },
      {
        ...deps(),
        complete: async () => ({ ok: false, text: '', error: '模拟的连接失败' }),
      },
    );
    expect(out.usedLlm).toBe(true);
    expect(out.draft.steps.length).toBeGreaterThan(0);
    expect(out.draft.generator).toBe('rule-kb-v1');
    expect(out.draft.notes.join()).toContain('大语言模型不可用');
  });

  it('★ 大模型全部编造构件时**不回退**：把问题暴露出来而不是悄悄换结果', async () => {
    const out = await generateDraft(
      { goal: '讲一下屋顶', audience: '', minutes: 1, useLlm: true },
      {
        ...deps(),
        complete: async () => ({
          ok: true,
          text: JSON.stringify({ title: '胡编的', steps: [{ targetId: '莫须有', narration: 'x', intentKind: 'EMPHASIZE' }] }),
        }),
      },
    );
    expect(out.draft.steps.length).toBe(0);
    expect(out.draft.warnings.length).toBeGreaterThan(0);
    expect(out.source).toContain('无可用结果');
  });

  it('大模型返回合法草稿时按原样采用', async () => {
    const out = await generateDraft(
      { goal: '屋顶', audience: '', minutes: 1, useLlm: true },
      {
        ...deps(),
        complete: async () => ({
          ok: true,
          text: JSON.stringify({
            title: '模型给的草稿',
            steps: [{
              title: '屋顶',
              narration: '屋顶覆盖整座厅堂。',
              targetId: 'hall@1/roof_front',
              intentKind: 'EMPHASIZE',
              durationMs: 5000,
              reason: '目标提到屋顶',
            }],
          }),
        }),
      },
    );
    expect(out.draft.generator).toContain('llm');
    expect(out.draft.steps).toHaveLength(1);
    expect(out.draft.steps[0].targetId).toBe('hall@1/roof_front');
  });

  it('场景未就绪时返回空草稿 + 一条明确告警，而不是抛异常', async () => {
    const out = await generateDraft({ goal: '屋顶', audience: '', minutes: null, useLlm: true }, {
      scene: () => null,
      settings: () => normalizeLlmSettings({}),
    });
    expect(out.draft.steps).toHaveLength(0);
    expect(out.draft.warnings.join()).toContain('场景尚未就绪');
  });

  it('即使模型标识为空也退回默认模型名（不发出 model: ""）', () => {
    expect(normalizeLlmSettings({ model: '   ' }).model).toBe('deepseek-chat');
  });
});

// ── 语言指令的执行（`applyInstructions`）──────────────────────

describe('语言指令落到数据上', () => {
  /** 建一个带两步的分镜，返回上下文。 */
  function withTwoSteps(): Harness {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const a = addStepFromSelection(h.ctx)!;
    setManualIntent(h.ctx, a, IntentKind.Emphasize);
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/roof_front' }));
    const b = addStepFromSelection(h.ctx)!;
    setManualIntent(h.ctx, b, IntentKind.Emphasize);
    return h;
  }

  const parseCtx = (h: Harness) => ({
    scene: SCENE,
    storyboard: h.ctx.stores.storyboard.get().storyboard,
    activeStepId: h.ctx.stores.storyboard.get().activeStepId,
    labelOf: (id: string) => h.ctx.labelOf(id),
  });

  /**
   * 把某一步设为「当前步骤」。
   *
   * **为什么测试里要显式做这一步**：「这一步环绕一周」这类指令里的「这一步」
   * 指的是**当前激活的步骤**，而新建步骤会把它挪到最后。若测试不显式指定，
   * 断言的落点就取决于「刚才最后加的是哪一步」——那是夹具的偶然，不是被测定行为。
   */
  const activate = (h: Harness, stepId: string): void => {
    h.ctx.stores.storyboard.set((s) => ({ ...s, activeStepId: stepId }));
  };

  /** 按目标构件 ID 找步骤（比按下标找更稳，不受排序影响）。 */
  const stepByTarget = (h: Harness, targetId: string) =>
    stepsOf(h).find((s) => s.target.form === 'single' && s.target.component.id === targetId)!;

  /** 取某一步单目标构件的 ID（关系型目标返回空串）。 */
  const targetIdOf = (step: { target: { form: string } }): string => {
    const t = step.target as { form: string; component?: { id: string } };
    return t.form === 'single' ? (t.component?.id ?? '') : '';
  };

  it('「把屋顶放到第一步」真的换了顺序', () => {
    const h = withTwoSteps();
    const parsed = parseEditInstruction('把屋顶放到第一步介绍', parseCtx(h));
    expect(parsed.recognized).toBe(true);
    const outcomes = applyInstructions(h.ctx, parsed.commands, { activeStepId: null });
    expect(outcomes.every((o) => o.ok)).toBe(true);
    // 断言落在**目标构件**上而不是标题文字上：夹具里的标签是英文 kind，
    // 标题里不会出现「屋顶」两个字，用文字断言会把测试的偶然当成行为
    expect(targetIdOf(stepsOf(h)[0])).toBe('hall@1/roof_front');
  });

  it('★「不要隐藏柱子」不会把柱子隐藏——否定式指令的语义不能反', () => {
    const h = withTwoSteps();
    activate(h, stepsOf(h)[0].id);
    const targetId = targetIdOf(stepsOf(h)[0]);
    const parsed = parseEditInstruction('不要把柱子隐藏掉', parseCtx(h));
    expect(parsed.recognized).toBe(true);
    const outcomes = applyInstructions(h.ctx, parsed.commands, { activeStepId: stepsOf(h)[0].id });
    expect(outcomes.every((o) => o.ok)).toBe(true);
    // ★ 关键断言：无论指令被理解成「保留」还是「高亮」，**hidden 里都不能有它**
    expect(stepByTarget(h, targetId).effects.hidden).toHaveLength(0);
  });

  it('「这一步环绕一周」写进运镜，且**不**把步骤标成待重算', () => {
    const h = withTwoSteps();
    activate(h, stepsOf(h)[0].id);
    solveStep(h.ctx, stepsOf(h)[0].id);
    const id = stepsOf(h)[0].id;
    const parsed = parseEditInstruction('这一步环绕一周', parseCtx(h));
    expect(parsed.recognized).toBe(true);
    applyInstructions(h.ctx, parsed.commands, { activeStepId: id });
    const after = stepsOf(h).find((s) => s.id === id)!;
    expect(after.motion?.degrees).toBe(360);
    // 运镜与「意图是否满足」无关；标 stale 会产生一个永远清不掉的徽章
    expect(after.solve).toBe('solved');
  });

  it('「第 9 步删掉」越界时不执行、不崩，并说明原因', () => {
    const h = withTwoSteps();
    const parsed = parseEditInstruction('把第 9 步删掉', parseCtx(h));
    const outcomes = applyInstructions(h.ctx, parsed.commands, { activeStepId: null });
    expect(stepsOf(h)).toHaveLength(2);
    expect(outcomes.some((o) => !o.ok)).toBe(true);
  });

  it('一次说三件事、其中一件说不通时，其余两件照常执行', () => {
    const h = withTwoSteps();
    activate(h, stepsOf(h)[0].id);
    const id = stepsOf(h)[0].id;
    const parsed = parseEditInstruction('这一步停 8 秒，然后高亮柱子，再把第 9 步删掉', parseCtx(h));
    const outcomes = applyInstructions(h.ctx, parsed.commands, { activeStepId: id });
    const ok = outcomes.filter((o) => o.ok).length;
    expect(ok).toBeGreaterThanOrEqual(2);
    expect(stepsOf(h).find((s) => s.id === id)!.durationMs).toBe(8000);
  });
});

// ── 反馈归因的执行（`applyFeedback`）──────────────────────────

describe('反馈驱动的局部调整', () => {
  it('★「这个视角看不清」→ 重算机位（而不是猜一个坐标）', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/roof_front' }));
    const stepId = addStepFromSelection(h.ctx)!;
    setManualIntent(h.ctx, stepId, IntentKind.Emphasize);
    solveStep(h.ctx, stepId);

    const diagnosis = diagnoseFeedback('这个视角看不清屋顶', {
      scene: SCENE,
      storyboard: h.ctx.stores.storyboard.get().storyboard,
      activeStepId: stepId,
    }).diagnoses[0];
    expect(diagnosis.aspect).toBe('viewpoint');
    expect(diagnosis.suggested).not.toBeNull();

    const outcome = applyFeedback(h.ctx, diagnosis, { activeStepId: stepId });
    expect(outcome.ok).toBe(true);
    expect(stepsOf(h)[0].solve).toBe('solved');
  });

  it('★「这一段讲得太复杂」不给任何动作——系统不替作者写旁白', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    const before = stepsOf(h)[0].narration;

    const diagnosis = diagnoseFeedback('这一段讲得太复杂了', {
      scene: SCENE,
      storyboard: h.ctx.stores.storyboard.get().storyboard,
      activeStepId: stepId,
    }).diagnoses[0];
    expect(diagnosis.aspect).toBe('content');
    expect(diagnosis.suggested).toBeNull();

    const outcome = applyFeedback(h.ctx, diagnosis, { activeStepId: stepId });
    expect(outcome.ok).toBe(false);
    expect(stepsOf(h)[0].narration).toBe(before);
  });

  it('「柱子应该一直保留」被归到视觉效果类，而不是无归因', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    const result = diagnoseFeedback('柱子应该一直保留', {
      scene: SCENE,
      storyboard: h.ctx.stores.storyboard.get().storyboard,
      activeStepId: stepId,
    });
    expect(result.recognized).toBe(true);
    expect(result.diagnoses[0].aspect).toBe('effects');
  });
});

// ── 运镜与重定向的独立性 ─────────────────────────────────────

describe('运镜与意图保持互不干扰', () => {
  it('设运镜不改动机位、不改意图、不改求解状态', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    setManualIntent(h.ctx, stepId, IntentKind.Emphasize);
    solveStep(h.ctx, stepId);
    const before = stepsOf(h)[0];

    setStepMotion(h.ctx, stepId, { kind: 'orbit', degrees: 180, pivot: null });
    const after = stepsOf(h)[0];

    expect(after.motion?.degrees).toBe(180);
    expect(after.camera).toEqual(before.camera);
    expect(after.intent).toEqual(before.intent);
    expect(after.solve).toBe('solved');
  });

  it('清掉运镜（传 null）后恢复为静态机位', () => {
    const h = harness();
    h.ctx.stores.selection.set((s) => ({ ...s, selectedId: 'hall@1/column_c__01' }));
    const stepId = addStepFromSelection(h.ctx)!;
    setStepMotion(h.ctx, stepId, { kind: 'orbit', degrees: 360, pivot: null });
    setStepMotion(h.ctx, stepId, null);
    expect(stepsOf(h)[0].motion).toBeNull();
  });
});

// ── 设置的本地持久化（key 不进仓库）────────────────────────────

describe('大模型设置的持久化', () => {
  function fakeStorage(initial: Record<string, string> = {}): Storage {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  }

  it('★ 默认设置里没有 key（代码里不存在任何硬编码凭据）', () => {
    expect(normalizeLlmSettings({}).apiKey).toBe('');
  });

  it('存下来的设置能原样读回', () => {
    const storage = fakeStorage();
    saveLlmSettings(normalizeLlmSettings({ model: 'deepseek-reasoner', endpoint: '/api/llm' }), storage);
    expect(loadLlmSettings(storage).model).toBe('deepseek-reasoner');
  });

  it('本地存储里是坏 JSON 时静默退回默认值，不让应用启动失败', () => {
    const storage = fakeStorage({ 'archcomposer.llm.v1': '{不是 JSON' });
    expect(loadLlmSettings(storage).model).toBe('deepseek-chat');
  });

  it('没有本地存储（隐私模式）时读写都不崩', () => {
    expect(loadLlmSettings(null).endpoint).toBe('/api/llm');
    expect(saveLlmSettings(normalizeLlmSettings({}), null)).toBe(false);
  });

  it('超出范围的温度被夹回合法区间', () => {
    expect(normalizeLlmSettings({ temperature: 9 }).temperature).toBe(1.5);
    expect(normalizeLlmSettings({ temperature: -3 }).temperature).toBe(0);
  });
});

// ── 知识表与构件匹配 ────────────────────────────────────────

describe('建筑知识表的行为', () => {
  it('★ 作者说的先后顺序优先于知识表的默认顺序', () => {
    const order = scanKnowledge('先讲屋顶，再讲柱子').map((h) => h.entry.name);
    expect(order[0]).toBe('屋顶');
    expect(order[1]).toBe('檐柱');
  });

  it('空目标给出一份默认讲解，而不是空手而归', () => {
    expect(planKnowledge('').length).toBeGreaterThan(0);
  });

  it('「从整体到局部」的说法会被认出来并按由大到小排', () => {
    const names = planKnowledge('从整体到局部讲一遍').map((e) => e.name);
    expect(names[0]).toBe('整体');
  });

  it('生成时每个目标构件都真实存在于模型里（86 个构件的厅堂也一样）', () => {
    const draft = generateRuleDraft(requestFor('讲一下斗拱、屋顶和柱子'));
    const ids = new Set(SCENE.components.map((c) => c.id));
    for (const step of draft.steps) {
      expect(ids.has(step.targetId)).toBe(true);
      if (step.partnerId) expect(ids.has(step.partnerId)).toBe(true);
    }
  });

  it('同一个请求两次生成结果一致（生成结果进回归链，不能有随机）', () => {
    const a = JSON.stringify(generateRuleDraft(requestFor('讲一下屋顶和柱子')));
    const b = JSON.stringify(generateRuleDraft(requestFor('讲一下屋顶和柱子')));
    expect(a).toBe(b);
  });

  it('LLM 生成器的名字带模型标识，便于论文里区分版本', async () => {
    const g = new LlmStoryboardGenerator(async () => ({ ok: false, text: '', error: 'x' }), 'deepseek-chat');
    expect(g.name).toBe('llm:deepseek-chat');
    expect(g.requiresNetwork).toBe(true);
  });
});

// ── 与求解状态的统计保持一致 ─────────────────────────────────

describe('生成后的分镜统计', () => {
  it('生成并求解后，步骤摘要里每一步都有可读的副标题', () => {
    const h = harness();
    adoptDraft(h.ctx, generateRuleDraft(requestFor('讲一下整体和屋顶')));
    const summaries = stepSummaries(h.ctx);
    expect(summaries.length).toBe(stepsOf(h).length);
    for (const s of summaries) expect(s.subtitle.length).toBeGreaterThan(0);
  });
});
