/**
 * L5 界面层 · M14 意图确认对话框（FR-14）
 *
 * 依据：《项目概要设计文档》§4.2.1、§6.1 的「展示候选列表 → 用户确认/修改」。
 *
 * **这个对话框是「人机边界」的可见形态。** 系统推断出候选意图，但**不替用户决定**：
 *  - 每个候选项都显示**置信度**与**推断理由**（「系统为什么这么认为」）；
 *  - 用户也可以完全不接受，直接手动选一个意图类型（§6.1 的失败兜底）；
 *  - 确认后才写入意图，并把 `confirmedByUser` 置真——论文里要区分「系统推断的」
 *    与「用户确认的」，这个标志就是那个区分。
 *
 * **为什么不做成「自动应用最高置信度的候选」**：因为那样一旦猜错，用户会觉得
 * 「系统擅自改了我要讲的东西」，而这类不可预期的自动行为在讲解创作工具里
 * 是明确的减分项。宁可多一次点击。
 */
import type { IntentPrediction } from '../../domain/types/intent.ts';
import { INTENT_LABELS, MEASURE_LABELS } from '../../domain/types/intent.ts';
import type { PredictionBundle } from '../../domain/types/storyboard.ts';
import { el, fill } from '../components/dom.ts';

export interface IntentDialogDeps {
  onAccept(prediction: IntentPrediction): void;
  onManual(kind: string): void;
  onSkip(): void;
}

export interface IntentDialog {
  root: HTMLElement;
  open(bundle: PredictionBundle): void;
  close(): void;
}

const MANUAL_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'EMPHASIZE', label: '强调目标' },
  { value: 'REDUCE_OCCLUSION', label: '减少遮挡' },
  { value: 'KEEP_CONTEXT', label: '保留结构上下文' },
  { value: 'REVEAL_RELATION', label: '揭示构件关系' },
  { value: 'SHOW_OVERVIEW', label: '总体俯瞰' },
];

export function createIntentDialog(deps: IntentDialogDeps): IntentDialog {
  const listHost = el('div', { class: 'intent-candidates' });
  const signalHost = el('div', { class: 'intent-signals' });
  const manualSelect = el('select', { class: 'intent-manual', 'aria-label': '手动选择意图' }) as HTMLSelectElement;
  manualSelect.append(el('option', { value: '', text: '或直接手动选择意图类型…' }));
  for (const choice of MANUAL_CHOICES) {
    manualSelect.append(el('option', { value: choice.value, text: choice.label }));
  }
  const manualButton = el('button', { class: 'apply-button', type: 'button', text: '用选中的类型' });
  const skipButton = el('button', { class: 'quiet-button', type: 'button', text: '暂不指定意图' });

  const header = el('div', { class: 'dialog-head' }, [
    el('strong', { text: '系统从这次示范中读到的意图' }),
    el('span', { class: 'dialog-hint', text: '请确认或修改——系统不会自动应用任何推断结果' }),
  ]);

  const root = el('div', { class: 'intent-dialog-backdrop', hidden: true }, [
    el('div', { class: 'intent-dialog', role: 'dialog', 'aria-modal': 'true' }, [
      header,
      listHost,
      signalHost,
      el('div', { class: 'dialog-manual' }, [manualSelect, manualButton]),
      el('div', { class: 'dialog-footer' }, [skipButton]),
    ]),
  ]);

  manualButton.addEventListener('click', () => {
    if (manualSelect.value) deps.onManual(manualSelect.value);
  });
  skipButton.addEventListener('click', () => deps.onSkip());

  function open(bundle: PredictionBundle): void {
    root.hidden = false;

    if (bundle.predictions.length === 0) {
      // §6.1 的失败处理：不猜。明确告诉用户，并突出「手动选择」这条路
      fill(listHost, [
        el('div', { class: 'intent-empty' }, [
          el('strong', { text: '未能识别出明确的意图' }),
          el('p', {
            text: '这次示范中没有出现足够清晰的信号（如明显的拉近、调透明、或旁白里的关系词）。请从下面手动选择这一步想达成什么。',
          }),
        ]),
      ]);
    } else {
      fill(listHost, bundle.predictions.map((prediction) => renderCandidate(prediction)));
    }

    fill(signalHost, bundle.signals.length > 0
      ? [
          el('div', { class: 'failure-subtitle', text: '系统依据的信号' }),
          el('ul', { class: 'signal-list' }, bundle.signals.map((s) =>
            el('li', { class: 'signal-item' }, [
              el('span', { class: 'signal-kind', text: s.kind }),
              el('span', { class: 'signal-detail', text: s.detail }),
            ]),
          )),
        ]
      : []);
  }

  function renderCandidate(prediction: IntentPrediction): HTMLElement {
    const percent = Math.round(prediction.intent.provenance.confidence * 100);
    const predicateItems = prediction.intent.predicates.map((p) =>
      el('li', {
        text: `${p.subjects.length > 0 ? '指定构件' : '目标'}的${MEASURE_LABELS[p.measure]}：${describeTest(p)}`,
      }),
    );

    const acceptButton = el('button', { class: 'apply-button', type: 'button', text: '采用这个意图' });
    acceptButton.addEventListener('click', () => deps.onAccept(prediction));

    return el('div', { class: 'intent-candidate' }, [
      el('div', { class: 'intent-candidate-head' }, [
        el('strong', { text: INTENT_LABELS[prediction.intent.kind] }),
        el('span', { class: `confidence-pill${percent >= 70 ? ' high' : ''}`, text: `置信度 ${percent}%` }),
      ]),
      el('p', { class: 'intent-rationale', text: prediction.intent.provenance.rationale }),
      el('div', { class: 'failure-subtitle', text: '这个意图会被翻译成这些可计算约束' }),
      el('ul', { class: 'predicate-list' }, predicateItems),
      acceptButton,
    ]);
  }

  return {
    root,
    open,
    close(): void {
      root.hidden = true;
    },
  };
}

/** 把谓词的目标值渲染成人话。 */
function describeTest(p: IntentPrediction['intent']['predicates'][number]): string {
  switch (p.test.op) {
    case '>=':
      return p.measure === 'screenCoverage'
        ? `至少占画面 ${Math.round(p.test.value * 100)}%`
        : `≥ ${p.test.value}`;
    case '<=':
      return `≤ ${p.test.value}`;
    case '==':
      return p.test.value === 1 ? '满足' : `${p.test.value}`;
    case 'in':
      return `${p.test.value[0].toFixed(2)} ~ ${p.test.value[1].toFixed(2)}`;
    default:
      return '';
  }
}
