/**
 * L5 界面层 · M14 步骤面板（分镜的编辑与重定向入口）
 *
 * 依据：《项目概要设计文档》§4.1 的 M14、§6.2（重定向的 UI 呈现）、FR-19。
 *
 * **面板上最重要的是两处呈现：**
 *
 *  1. **求解状态徽章**（已求解 / 待重算 / 求解失败 / 未求解）。其中「待重算」
 *     就是 §5.6 那个 `SolveState.Stale` 在界面上的样子。Navisworks 的视点
 *     没有任何等价状态——它连「我该重算了」都表达不出来。
 *
 *  2. **失败时显示冲突清单与替代方案**（FR-19）。求解失败不会被藏起来，
 *     而是变成面板上一块醒目的区域，写明「哪条约束没满足、可以怎么办」。
 */
import type { StoryboardStore, SelectionStore, SceneStore } from '../../app/stores/stores.ts';
import type { StoryboardStep, SolveState } from '../../domain/types/storyboard.ts';
import { SOLVE_STATE_LABELS } from '../../domain/types/storyboard.ts';
import type { ComponentId } from '../../domain/types/component.ts';
import type { ConstraintConflict } from '../../domain/types/solver.ts';
import { el, fill, solveStateClass } from '../components/dom.ts';

/** 面板需要的宿主能力。全部由 main.ts 注入，面板自身不含业务规则。 */
export interface StepPanelDeps {
  storyboard: StoryboardStore;
  selection: SelectionStore;
  scene: SceneStore;
  labelOf(id: ComponentId): string;
  /** 新建步骤（用当前选中构件） */
  onAddStep(): void;
  onDeleteStep(id: string): void;
  onDuplicateStep(id: string): void;
  onMoveStep(from: number, to: number): void;
  onSelectStep(id: string): void;
  /** 改目标并重解（核心流程） */
  /**
   * 换目标并重解。
   *
   * `candidateId` 省略时由命令层自己挑一个候选（工具条上的「⇄ 换目标并重解」）；
   * 传了就换成**指定的那一个**（失败区里点某个候选 chip 时）。
   *
   * ⚠️ 这个参数是后加的：最初 chip 也只传 `step.id`，于是**点任何一个 chip 都会换到
   * 排序第一的那个构件**——用户点了「西侧檐柱」却换成了「东侧檐柱」。
   * 界面显示的标签与实际的动作用不一致，是那种「看起来能用、用起来不对劲」的 bug。
   */
  onRedirectStep(id: string, candidateId?: string): void;
  /** 仅求解（不换目标） */
  onSolveStep(id: string): void;
  onPreviewStep(id: string): void;
  onSetIntent(id: string, kind: string): void;
  onUpdateText(id: string, patch: { title?: string; narration?: string; durationMs?: number }): void;
  /** 候选替换列表 */
  candidates(id: string): ComponentId[];
  /** 失败详情（冲突 + 建议），由 L4 提供 */
  failureInfo(id: string): { conflicts: ConstraintConflict[]; remedies: string[]; note: string } | null;
}

export interface StepPanel {
  root: HTMLElement;
  render(): void;
}

const INTENT_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'EMPHASIZE', label: '强调目标' },
  { value: 'REDUCE_OCCLUSION', label: '减少遮挡' },
  { value: 'KEEP_CONTEXT', label: '保留上下文' },
  { value: 'REVEAL_RELATION', label: '揭示关系' },
  { value: 'SHOW_OVERVIEW', label: '总体俯瞰' },
];

export function createStepPanel(deps: StepPanelDeps): StepPanel {
  const listHost = el('div', { class: 'step-list', id: 'step-list' });
  const statsLine = el('span', { class: 'step-stats', id: 'step-stats' });
  const addButton = el('button', { class: 'apply-button', id: 'add-step', type: 'button', text: '＋ 用选中构件新建步骤' });

  const root = el('section', { class: 'side-section step-section' }, [
    el('div', { class: 'section-title' }, [
      el('strong', { text: '分镜步骤' }),
      statsLine,
    ]),
    addButton,
    listHost,
  ]);

  addButton.addEventListener('click', () => deps.onAddStep());

  function render(): void {
    const state = deps.storyboard.get();
    const steps = state.storyboard.steps;

    const counts: Record<SolveState, number> = { none: 0, solved: 0, stale: 0, failed: 0 };
    for (const s of steps) counts[s.solve] += 1;
    statsLine.textContent = steps.length === 0
      ? '暂无步骤'
      : `${steps.length} 步 · 已求解 ${counts.solved} · 待重算 ${counts.stale} · 失败 ${counts.failed}`;

    if (steps.length === 0) {
      fill(listHost, [el('div', { class: 'empty-state', text: '先在场景里选一个构件，再点上面的按钮新建步骤' })]);
      return;
    }

    fill(listHost, steps.map((step, index) => renderStepRow(step, index)));
  }

  function renderStepRow(step: StoryboardStep, index: number): HTMLElement {
    const active = deps.storyboard.get().activeStepId === step.id;

    // ── 标题行：序号、标题（可编辑）、状态徽章 ──
    const titleInput = el('input', {
      class: 'step-title-input',
      type: 'text',
      value: step.title,
      'aria-label': '步骤标题',
    }) as HTMLInputElement;
    titleInput.addEventListener('change', () => deps.onUpdateText(step.id, { title: titleInput.value }));
    titleInput.addEventListener('click', (event) => event.stopPropagation());

    const badge = el('span', {
      class: `state-badge ${solveStateClass(step.solve)}`,
      text: SOLVE_STATE_LABELS[step.solve],
      title: step.solveNote ?? '',
    });

    const header = el('div', { class: 'step-header' }, [
      el('span', { class: 'step-index', text: `${index + 1}` }),
      titleInput,
      badge,
    ]);

    // ── 目标与意图摘要 ──
    const targetText = step.target.form === 'single'
      ? deps.labelOf(step.target.component.id)
      : `${deps.labelOf(step.target.from.id)} ↔ ${deps.labelOf(step.target.to.id)}`;
    const intentText = step.intent
      ? `${step.intent.kind}${step.intent.provenance.confirmedByUser ? '（已确认）' : '（未确认）'}`
      : '未指定意图';

    const summary = el('div', { class: 'step-summary' }, [
      el('span', { class: 'step-target', text: `目标：${targetText}`, title: targetText }),
      el('span', { class: 'step-intent', text: `意图：${intentText}` }),
    ]);

    // ── 旁白编辑 ──
    const narration = el('textarea', {
      class: 'step-narration',
      rows: 2,
      placeholder: '这一步要讲的旁白…',
    }) as HTMLTextAreaElement;
    narration.value = step.narration;
    narration.addEventListener('change', () => deps.onUpdateText(step.id, { narration: narration.value }));
    narration.addEventListener('click', (event) => event.stopPropagation());

    // ── 时长 ──
    const duration = el('input', {
      class: 'step-duration',
      type: 'number',
      min: 500,
      max: 60000,
      step: 500,
      value: step.durationMs,
      'aria-label': '时长（毫秒）',
    }) as HTMLInputElement;
    duration.addEventListener('change', () =>
      deps.onUpdateText(step.id, { durationMs: Number(duration.value) }),
    );
    duration.addEventListener('click', (event) => event.stopPropagation());

    const durationRow = el('div', { class: 'step-duration-row' }, [
      el('label', { text: '时长(ms)' }),
      duration,
    ]);

    // ── ★ 意图选择（FR-14 的「人工确认」路径，也是 §6.1 的失败兜底）──
    const intentSelect = el('select', { class: 'step-intent-select', 'aria-label': '设置意图' }) as HTMLSelectElement;
    intentSelect.append(el('option', { value: '', text: '选择意图类型…' }));
    for (const choice of INTENT_CHOICES) {
      const option = el('option', { value: choice.value, text: choice.label }) as HTMLOptionElement;
      if (step.intent?.kind === choice.value) option.selected = true;
      intentSelect.append(option);
    }
    intentSelect.addEventListener('change', () => {
      if (intentSelect.value) deps.onSetIntent(step.id, intentSelect.value);
    });
    intentSelect.addEventListener('click', (event) => event.stopPropagation());

    // ── 主操作：按意图求解 / 换目标并重解 ──
    const solveButton = el('button', {
      class: 'step-action primary',
      type: 'button',
      text: step.solve === 'solved' ? '⟲ 重新求解' : '▷ 按意图求解机位',
    });
    solveButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deps.onSolveStep(step.id);
    });

    const redirectButton = el('button', {
      class: 'step-action',
      type: 'button',
      text: '⇄ 换目标并重解',
      title: '更换目标构件，意图保持不变，系统按原意图重新求解机位',
    });
    redirectButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deps.onRedirectStep(step.id);
    });

    const previewButton = el('button', {
      class: 'step-action quiet',
      type: 'button',
      text: '◉ 预览',
    });
    previewButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deps.onPreviewStep(step.id);
    });

    const duplicateButton = el('button', { class: 'step-action quiet', type: 'button', text: '⧉ 复制' });
    duplicateButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deps.onDuplicateStep(step.id);
    });

    const deleteButton = el('button', { class: 'step-action danger', type: 'button', text: '✕ 删除' });
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deps.onDeleteStep(step.id);
    });

    const actions = el('div', { class: 'step-actions' }, [
      solveButton, redirectButton, previewButton, duplicateButton, deleteButton,
    ]);

    const children: Node[] = [header, summary, intentSelect, narration, durationRow, actions];
    const failure = deps.failureInfo(step.id);
    if (failure) children.push(renderFailure(step, failure));

    const row = el('div', {
      class: `step-row${active ? ' active' : ''}`,
      'data-step-id': step.id,
      'data-solve': step.solve,
    }, children);

    row.addEventListener('click', () => deps.onSelectStep(step.id));
    return row;
  }

  /**
   * 失败区（FR-19 的界面形态）。
   *
   * **这块区域的存在本身就是论文的论点之一。** 竞品在求解/匹配失败时通常
   * 「静默产出劣质结果」，用户看到的是一个看起来正常、实际不达标的画面，
   * 且**没有任何线索知道它不达标**。这里反过来：把「哪条约束没满足、实测多少、
   * 要求多少、可以怎么办」全部摊开。
   */
  function renderFailure(
    step: StoryboardStep,
    info: { conflicts: ConstraintConflict[]; remedies: string[]; note: string },
  ): HTMLElement {
    const conflictItems = info.conflicts.map((c) =>
      el('li', { class: 'conflict-item' }, [
        el('strong', { text: c.measure }),
        el('span', { class: 'conflict-detail', text: `实测 ${formatNumber(c.achieved)}，要求 ${c.required}` }),
        c.note ? el('p', { class: 'conflict-note', text: c.note }) : el('span'),
      ]),
    );

    const remedyItems = info.remedies.map((r) => el('li', { text: r }));

    // 「换一个同类构件试试」——失败后最常见、也最有效的下一步
    const candidates = deps.candidates(step.id);
    const candidateArea = candidates.length > 0
      ? el('div', { class: 'candidate-area' }, [
          el('span', { class: 'candidate-label', text: '可换的同类构件：' }),
          el('div', { class: 'candidate-chips' }, candidates.slice(0, 6).map((id) => {
            const chip = el('button', { class: 'candidate-chip', type: 'button', text: deps.labelOf(id), title: id });
            chip.addEventListener('click', (event) => {
              event.stopPropagation();
              deps.onSelectStep(step.id);
              // ★ 传 chip 自己的构件 ID，而不是让命令层另挑一个
              deps.onRedirectStep(step.id, id);
            });
            return chip;
          })),
        ])
      : el('span');

    return el('div', { class: 'failure-box', role: 'alert' }, [
      el('div', { class: 'failure-head' }, [
        el('strong', { text: step.solve === 'failed' ? '⚠ 求解未通过' : '⚠ 需要重算' }),
        el('span', { class: 'failure-note', text: info.note }),
      ]),
      conflictItems.length > 0
        ? el('div', {}, [
            el('div', { class: 'failure-subtitle', text: '未满足的约束' }),
            el('ul', { class: 'conflict-list' }, conflictItems),
          ])
        : el('span'),
      remedyItems.length > 0
        ? el('div', {}, [
            el('div', { class: 'failure-subtitle', text: '可以尝试' }),
            el('ul', { class: 'remedy-list' }, remedyItems),
          ])
        : el('span'),
      candidateArea,
    ]);
  }

  return { root, render };
}

/** 数字格式化：整数不带小数点，小数保留 3 位。 */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}
