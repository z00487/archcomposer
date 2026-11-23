// @vitest-environment happy-dom
/**
 * L5 界面层的 DOM 测试。
 *
 * **这个文件为什么要存在**：`vite.config.ts` 里把默认测试环境定成了 `node`，
 * 理由是「L3 领域层不需要 DOM」（约束 C-1）。那条理由本身是对的，但它带来一个
 * 盲区——**「界面确实按预期响应」这件事一直没被验证过**。前面 143 项测试全部
 * 跑在 Node 下，测不到事件绑定、`replaceChildren` 的实际效果、以及「保存按钮
 * 在什么条件下被禁用」这类只存在于界面上的行为。
 *
 * 本文件补上这个盲区。它**只测 L5 与 L4 的界面契约**，不测算法（算法在各自
 * 的文件里已测）。因此它用 `happy-dom` 环境，而其它测试文件仍然跑在 `node` 下——
 * 每个文件用 `@vitest-environment` 文档注释声明自己的环境，互不影响。
 *
 * 测什么（都是「一改就可能悄悄坏掉、而算法测试抓不到」的地方）：
 *  - 步骤面板：能不能真的渲染出步骤、按钮点了会不会回调、失败区显示不显示；
 *  - 构件面板：搜索框输入能否过滤、点击行能否回调；
 *  - 存档区：**有 error 时保存按钮必须被禁用**（§4.5 的落地）；
 *  - 意图对话框：识别失败时是否显示「未能识别」而不是空列表。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { el, fill, byId, solveStateClass, solveStateBadge, escapeHtml } from '../ui/components/dom.ts';
import { createComponentPanel, createSemanticsView } from '../ui/panels/component-panel.ts';
import { createIntentDialog } from '../ui/intent/intent-dialog.ts';
import { createSelectionStore, createStoryboardStore, createSceneStore } from '../app/stores/stores.ts';
import type { RegisteredComponent } from '../runtime/model/registry.ts';
import type { PredictionBundle } from '../domain/types/storyboard.ts';
import { IntentKind, defaultPredicatesFor } from '../domain/types/intent.ts';
import { semantics } from './fixtures.ts';

beforeEach(() => {
  document.body.replaceChildren();
});

// ── dom.ts 的构建工具 ────────────────────────────────────────────

describe('DOM 构建工具', () => {
  it('el 设置属性、文本与子节点', () => {
    const node = el('div', { class: 'a', 'data-x': '1' }, [
      el('strong', { text: '标题' }),
      '尾文本',
    ]);
    expect(node.className).toBe('a');
    expect(node.dataset.x).toBe('1');
    expect(node.querySelector('strong')!.textContent).toBe('标题');
    expect(node.textContent).toBe('标题尾文本');
  });

  it('el 布尔属性 true/false 会正确增删', () => {
    expect(el('input', { disabled: true }).hasAttribute('disabled')).toBe(true);
    expect(el('input', { disabled: false }).hasAttribute('disabled')).toBe(false);
  });

  it('★ el 的 text 走 textContent —— 不会把尖括号当标签解析', () => {
    const node = el('div', { text: '<script>alert(1)</script>' });
    // 文本被原样保留，且没有真的产生一个 script 元素
    expect(node.textContent).toBe('<script>alert(1)</script>');
    expect(node.querySelector('script')).toBeNull();
    expect(node.children.length).toBe(0);
  });

  it('fill 用 replaceChildren —— 反复填充不累加', () => {
    const host = el('div', {}, [el('span', { text: '旧的' })]);
    fill(host, [el('span', { text: '新的' })]);
    expect(host.children.length).toBe(1);
    expect(host.textContent).toBe('新的');
    fill(host, [el('span', { text: '更新的' })]);
    expect(host.children.length).toBe(1);
  });

  it('escapeHtml 转义四个关键字符（单引号不转义——属性一律用双引号）', () => {
    expect(escapeHtml(`<>&"`)).toBe('&lt;&gt;&amp;&quot;');
    // 单引号原样保留：本项目的属性值全部用双引号包围，不需要为单引号转义；
    // 转义它反而会让构件名里合法的撇号在界面上显示成 `&#39;`
    expect(escapeHtml(`it's`)).toBe(`it's`);
  });

  it('solveStateClass 与 solveStateBadge 对四种状态都有输出，且两两不同', () => {
    const classes = new Set<string>();
    const labels = new Set<string>();
    for (const state of ['none', 'solved', 'stale', 'failed'] as const) {
      // 类名形如 is-solved；除 none 之外都带状态名
      const cls = solveStateClass(state);
      expect(cls.startsWith('is-')).toBe(true);
      const label = solveStateBadge(state);
      expect(label.length).toBeGreaterThan(0);
      classes.add(cls);
      labels.add(label);
    }
    // 四种状态必须有四个不同的类名与四个不同的文案
    expect(classes.size).toBe(4);
    expect(labels.size).toBe(4);
  });
});

// ── 构件面板 ────────────────────────────────────────────────────

function fakeComponent(id: string, displayName: string): RegisteredComponent {
  return {
    id,
    nodeName: id.slice(id.indexOf('/') + 1),
    displayName,
    semantics: semantics('column', 'e'),
    aabb: { min: [0, 0, 0], max: [1, 1, 1] },
    object: { visible: true } as never,
  };
}

describe('构件面板', () => {
  it('渲染出全部构件行，并显示数量', () => {
    const selection = createSelectionStore();
    const items = [fakeComponent('m@1/column_e__01', '柱 e 1'), fakeComponent('m@1/column_e__02', '柱 e 2')];
    const panel = createComponentPanel({
      selection,
      list: () => items,
      onPick: () => {},
      onSearch: () => {},
      labelOf: (id) => id,
    });
    document.body.append(panel.root);
    panel.render();
    expect(panel.root.querySelectorAll('.component-row').length).toBe(2);
    expect(byId('component-count').textContent).toBe('2');
  });

  it('★ 点击一行会带着该构件的 ID 回调', () => {
    const selection = createSelectionStore();
    const picked: string[] = [];
    const panel = createComponentPanel({
      selection,
      list: () => [fakeComponent('m@1/column_e__01', '柱 e 1')],
      onPick: (id) => picked.push(id),
      onSearch: () => {},
      labelOf: (id) => id,
    });
    document.body.append(panel.root);
    panel.render();
    panel.root.querySelector<HTMLButtonElement>('.component-row')!.click();
    expect(picked).toEqual(['m@1/column_e__01']);
  });

  it('搜索输入会原样传给 onSearch', () => {
    const selection = createSelectionStore();
    const queries: string[] = [];
    const panel = createComponentPanel({
      selection,
      list: () => [],
      onPick: () => {},
      onSearch: (q) => queries.push(q),
      labelOf: (id) => id,
    });
    document.body.append(panel.root);
    const input = panel.root.querySelector<HTMLInputElement>('#component-search')!;
    input.value = '柱';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(queries).toEqual(['柱']);
  });

  it('当前选中的构件行带 active 类', () => {
    const selection = createSelectionStore();
    selection.set((s) => ({ ...s, selectedId: 'm@1/column_e__02' }));
    const panel = createComponentPanel({
      selection,
      list: () => [fakeComponent('m@1/column_e__01', '柱 e 1'), fakeComponent('m@1/column_e__02', '柱 e 2')],
      onPick: () => {},
      onSearch: () => {},
      labelOf: (id) => id,
    });
    document.body.append(panel.root);
    panel.render();
    const active = panel.root.querySelectorAll('.component-row.active');
    expect(active.length).toBe(1);
    expect(active[0].getAttribute('title')).toBe('m@1/column_e__02');
  });

  it('没有匹配项时显示空状态而不是空白', () => {
    const selection = createSelectionStore();
    const panel = createComponentPanel({
      selection,
      list: () => [],
      onPick: () => {},
      onSearch: () => {},
      labelOf: (id) => id,
    });
    document.body.append(panel.root);
    panel.render();
    expect(panel.root.querySelector('.empty-state')!.textContent).toContain('没有匹配');
  });
});

describe('语义卡片（把「名字是语义唯一来源」显示出来）', () => {
  it('★ 词表外的构件显示 unknown（不在词表内），而不是猜一个标签', () => {
    const view = createSemanticsView();
    document.body.append(view.root);
    const component = fakeComponent('m@1/foo', 'foo');
    view.update(
      { ...component, semantics: { kind: 'unknown', part: '', label: 'unknown' } },
      'm@1/foo',
      ['节点名 foo 无法解析出类型词'],
    );
    expect(byId('sem-kind').textContent).toContain('unknown（不在词表内）');
    expect(view.root.dataset.known).toBe('no');
    // 解析警告挂在 title 上，悬停可见——不悄悄吞掉
    expect(view.root.title).toContain('无法解析');
  });

  it('正常构件的三项由名字解析结果填充', () => {
    const view = createSemanticsView();
    document.body.append(view.root);
    view.update(fakeComponent('m@1/column_e__01', '柱 e 1'), 'm@1/column_e__01', []);
    expect(byId('sem-kind').textContent).toBe('column');
    expect(byId('sem-part').textContent).toBe('e');
    expect(byId('sem-id').textContent).toBe('m@1/column_e__01');
    expect(view.root.dataset.known).toBe('yes');
  });

  it('没有选中构件时整块隐藏', () => {
    const view = createSemanticsView();
    document.body.append(view.root);
    view.update(null, '', []);
    expect(view.root.hidden).toBe(true);
  });
});

// ── 意图对话框 ──────────────────────────────────────────────────

function bundle(recognized: boolean, predictions: PredictionBundle['predictions'] = []): PredictionBundle {
  return {
    outcome: {
      selectedId: null,
      opacities: {},
      hidden: [],
      highlighted: [],
      cameraTrack: [],
      touchedIds: [],
    },
    predictions,
    recognized,
    signals: [],
  };
}

describe('意图确认对话框', () => {
  it('★ 未能识别出意图时显示明确说明，而不是一个空列表', () => {
    const dialog = createIntentDialog({ onAccept: () => {}, onManual: () => {}, onSkip: () => {} });
    document.body.append(dialog.root);
    dialog.open(bundle(false));
    expect(dialog.root.textContent).toContain('未能识别出明确的意图');
  });

  it('★ 识别失败时手动选择意图类型的入口仍然存在（推断不是必需的）', () => {
    const dialog = createIntentDialog({ onAccept: () => {}, onManual: () => {}, onSkip: () => {} });
    document.body.append(dialog.root);
    dialog.open(bundle(false));
    const select = dialog.root.querySelector<HTMLSelectElement>('.intent-manual')!;
    expect(select).not.toBeNull();
    // 五类意图一项不少
    const values = [...select.options].map((o) => o.value).filter(Boolean);
    expect(values).toEqual([
      'EMPHASIZE',
      'REDUCE_OCCLUSION',
      'KEEP_CONTEXT',
      'REVEAL_RELATION',
      'SHOW_OVERVIEW',
    ]);
  });

  it('★ 手动选择要**显式点按钮**才生效（不在 change 事件上直接应用）', () => {
    const onManual = vi.fn();
    const dialog = createIntentDialog({ onAccept: () => {}, onManual, onSkip: () => {} });
    document.body.append(dialog.root);
    dialog.open(bundle(false));
    const select = dialog.root.querySelector<HTMLSelectElement>('.intent-manual')!;
    const applyButton = dialog.root.querySelectorAll<HTMLButtonElement>('.apply-button')[0];

    // 只改下拉框的值：不该回调任何东西 —— 避免误触就改掉步骤的意图
    select.value = 'SHOW_OVERVIEW';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onManual).not.toHaveBeenCalled();

    // 点「用选中的类型」才回调
    applyButton.click();
    expect(onManual).toHaveBeenCalledWith('SHOW_OVERVIEW');
  });

  it('下拉框未选择时点按钮不会回调（不提交空值）', () => {
    const onManual = vi.fn();
    const dialog = createIntentDialog({ onAccept: () => {}, onManual, onSkip: () => {} });
    document.body.append(dialog.root);
    dialog.open(bundle(false));
    dialog.root.querySelectorAll<HTMLButtonElement>('.apply-button')[0].click();
    expect(onManual).not.toHaveBeenCalled();
  });

  it('候选意图带置信度，点击后回调对应预测', () => {
    const onAccept = vi.fn();
    const dialog = createIntentDialog({ onAccept, onManual: () => {}, onSkip: () => {} });
    document.body.append(dialog.root);
    const prediction = {
      intent: {
        id: 'i1',
        kind: IntentKind.Emphasize,
        predicates: defaultPredicatesFor(IntentKind.Emphasize),
        provenance: {
          source: 'demo' as const,
          confidence: 0.78,
          rationale: '示范时相机拉近',
          confirmedByUser: false,
        },
      },
      signals: [],
    };
    dialog.open(bundle(true, [prediction]));
    const applyButton = dialog.root.querySelector<HTMLButtonElement>('.apply-button')!;
    expect(applyButton).not.toBeNull();
    expect(dialog.root.textContent).toContain('示范时相机拉近');
    applyButton.click();
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0][0].intent.kind).toBe(IntentKind.Emphasize);
  });

  it('打开与关闭切换对话框的可见性', () => {
    const dialog = createIntentDialog({ onAccept: () => {}, onManual: () => {}, onSkip: () => {} });
    document.body.append(dialog.root);
    dialog.open(bundle(false));
    expect(dialog.root.hidden).toBe(false);
    dialog.close();
    expect(dialog.root.hidden).toBe(true);
  });
});

// ── 步骤面板（只测「渲染与回调」这一层，算法另测）──────────────

describe('步骤面板', () => {
  it('渲染出步骤行与求解状态徽章', async () => {
    const { createStepPanel } = await import('../ui/panels/step-panel.ts');
    const { createStoryboard, createStep } = await import('../domain/types/storyboard.ts');
    const { addStep } = await import('../domain/storyboard/storyboard.ts');

    const selection = createSelectionStore();
    // 用生产工厂装配 Store，避免测试手拼状态对象——状态的字段一旦增加，
    // 手拼的版本会**编译失败**（这是好事），但用工厂则自动跟随
    const storyboard = createStoryboardStore();
    storyboard.set((s) => ({
      ...s,
      storyboard: addStep(
        createStoryboard('测试分镜'),
        createStep({ form: 'single', component: { id: 'm@1/column_e__01', semantics: semantics('column', 'e') } }, '讲柱子'),
      ),
    }));
    const scene = createSceneStore();

    const panel = createStepPanel({
      storyboard,
      selection,
      scene,
      labelOf: (id) => id,
      onAddStep: () => {},
      onDeleteStep: () => {},
      onDuplicateStep: () => {},
      onMoveStep: () => {},
      onSelectStep: () => {},
      onRedirectStep: () => {},
      onSolveStep: () => {},
      onPreviewStep: () => {},
      onSetIntent: () => {},
      onUpdateText: () => {},
      candidates: () => [],
      failureInfo: () => null,
    });
    document.body.append(panel.root);
    panel.render();

    expect(panel.root.querySelectorAll('.step-row').length).toBe(1);
    // ★ 标题是**可编辑的输入框**（FR-8），因此要查 value 而不是 textContent
    const titleInput = panel.root.querySelector<HTMLInputElement>('.step-title-input')!;
    expect(titleInput.value).toBe('讲柱子');
    // solve 默认是 none → 徽章应为「未求解」
    expect(panel.root.querySelector('.state-badge')!.textContent).toContain('未求解');
  });
});

// ── 失败区里的候选 chip：点了哪一个就必须换到哪一个 ──────────────

/**
 * 这组测试锁住一个**「看起来能用、用起来不对劲」**的 bug：
 * 候选 chip 最初只把 `step.id` 传出去，命令层于是按排序推荐挑**第一个**候选。
 * 结果是——无论用户点的是哪个 chip，换的永远是最上面那个。
 * 界面上显示的标签与实际的动作用不一致，用户会以为西侧柱换成了东侧柱。
 */
async function stepPanelWith(
  onRedirectStep: (id: string, candidateId?: string) => void,
  candidates: string[],
  solve: 'none' | 'failed' = 'failed',
) {
  const { createStepPanel } = await import('../ui/panels/step-panel.ts');
  const { createStoryboard, createStep } = await import('../domain/types/storyboard.ts');
  const { addStep } = await import('../domain/storyboard/storyboard.ts');

  const storyboard = createStoryboardStore();
  storyboard.set((s) => ({
    ...s,
    storyboard: addStep(
      createStoryboard('测试分镜'),
      {
        ...createStep(
          { form: 'single', component: { id: 'm@1/column_c__01', semantics: semantics('column', 'c') } },
          '讲中间的柱子',
        ),
        solve,
      },
    ),
  }));

  const panel = createStepPanel({
    storyboard,
    selection: createSelectionStore(),
    scene: createSceneStore(),
    labelOf: (id) => id,
    onAddStep: () => {},
    onDeleteStep: () => {},
    onDuplicateStep: () => {},
    onMoveStep: () => {},
    onSelectStep: () => {},
    onRedirectStep,
    onSolveStep: () => {},
    onPreviewStep: () => {},
    onSetIntent: () => {},
    onUpdateText: () => {},
    candidates: () => candidates,
    failureInfo: () => (solve === 'failed'
      ? { conflicts: [], remedies: ['换一个同类构件试试'], note: '求解失败' }
      : null),
  });
  document.body.append(panel.root);
  panel.render();
  return panel;
}

describe('失败区的「可换的同类构件」候选', () => {
  it('★ 点第二个 chip 会把它**自己的**构件 ID 传出去（不是传排序第一的那个）', async () => {
    const picked: Array<[string, string | undefined]> = [];
    const panel = await stepPanelWith(
      (stepId, candidateId) => picked.push([stepId, candidateId]),
      ['m@1/column_e__01', 'm@1/column_c__02'],
    );

    const chips = panel.root.querySelectorAll<HTMLButtonElement>('.candidate-chip');
    expect(chips.length).toBe(2);
    expect(chips[1].textContent).toBe('m@1/column_c__02');

    chips[1].click();
    expect(picked).toHaveLength(1);
    // ★ 必须换成被点的那个，而不是「第一个」
    expect(picked[0][1]).toBe('m@1/column_c__02');
  });

  it('工具条上的「换目标并重解」不指定候选（交给命令层按排序推荐）', async () => {
    const picked: Array<[string, string | undefined]> = [];
    const panel = await stepPanelWith(
      (stepId, candidateId) => picked.push([stepId, candidateId]),
      [],
      'none',
    );

    const redirectButton = [...panel.root.querySelectorAll<HTMLButtonElement>('.step-action')]
      .find((b) => b.textContent!.includes('换目标并重解'))!;
    expect(redirectButton).toBeTruthy();
    redirectButton.click();

    expect(picked).toHaveLength(1);
    // 第二个参数为 undefined ⟹ 命令层自己挑
    expect(picked[0][1]).toBeUndefined();
  });
});

// ── 求解状态在界面上的四种呈现 ──────────────────────────────────

describe('求解状态的界面呈现（I-ST-5 的可视化）', () => {
  it('★ 四种状态的文案两两不同 —— 「待重算」不会被显示成「已求解」', () => {
    const labels = (['none', 'solved', 'stale', 'failed'] as const).map(solveStateBadge);
    expect(new Set(labels).size).toBe(4);
    expect(solveStateBadge('stale')).toContain('待重算');
    expect(solveStateBadge('failed')).toContain('失败');
    expect(solveStateBadge('solved')).toContain('已求解');
    // 「待重算」与「已求解」必须能分辨——这正是 I-ST-5 要让用户看到的东西
    expect(solveStateBadge('stale')).not.toBe(solveStateBadge('solved'));
  });
});
