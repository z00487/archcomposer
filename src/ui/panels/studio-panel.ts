/**
 * L5 界面层 · 生成 / 语言编创面板
 *
 * 依据：答辩 PPT 第 3 页的「01 生成 / 03 编辑」、第 5 页的流程第一跳，
 * 以及开题报告 §3.2（完整解说草稿生成）、§3.3（自然语言与三维操作融合）、
 * §3.6（创作者反馈驱动的局部优化）。
 *
 * **把「生成」和「编辑」放在同一个面板里，是因为它们在作者心里就是一件事**：
 * 「我先给它一句话，它给我一版草稿；然后我接着说，它改。」拆成三个面板会让
 * 作者在三个地方之间来回找入口，而它们本该是同一段对话。
 *
 * **本层不含业务规则**：解析在 L3（`domain/language/`）、生成在 L3
 * （`domain/generator/`）、执行在 L4（`app/commands/`）、网络在 L4
 * （`app/llm/`）。面板只做三件事：收集输入、把结果画出来、把点击转成回调。
 * 这条纪律的回报是——「什么是合法的指令」「什么算高置信度」这些问题在界面上
 * 永远只有一个答案：不用界面回答。
 */
import type { GenerationStore, LanguageStore } from '../../app/stores/stores.ts';
import type { GenerationDraft } from '../../domain/generator/types.ts';
import type { ParseResult, EditCommand } from '../../domain/language/instructions.ts';
import type { FeedbackResult } from '../../domain/language/feedback.ts';
import { ASPECT_LABELS, describeDiagnosis } from '../../domain/language/feedback.ts';
import { INTENT_LABELS } from '../../domain/types/intent.ts';
import { el, fill } from '../components/dom.ts';

export interface StudioPanelDeps {
  generation: GenerationStore;
  language: LanguageStore;

  /** 生成：输入来自三个控件；`useLlm` 决定走大模型还是离线知识表 */
  onGenerate(input: { goal: string; audience: string; minutes: number | null; useLlm: boolean }): void;
  /** 采纳草稿（落成真实步骤并就地求解） */
  onAdoptDraft(draft: GenerationDraft): void;
  /** 丢弃草稿 */
  onDiscardDraft(): void;

  /** 解析一条语言指令（**先解析、不执行**，让作者核对理解是否正确） */
  onParseInstruction(text: string): void;
  /** 执行上一次解析出的指令 */
  onApplyParsed(): void;
  /** 清空解析结果 */
  onClearParsed(): void;

  /** 提交一条反馈（归因 + 建议），`index` 为要执行的那条建议 */
  onFeedback(text: string): void;
  onApplyDiagnosis(index: number): void;

  /** 一键把某个步骤设为环绕运镜（供草稿外的快速操作） */
  onQuickOrbit(degrees: number): void;
}

export interface StudioPanel {
  root: HTMLElement;
  render(): void;
}

export function createStudioPanel(deps: StudioPanelDeps): StudioPanel {
  const gen = createGenerationSection(deps);
  const lang = createLanguageSection(deps);

  const root = el('div', { class: 'studio-root' }, [gen.root, lang.root]);

  function render(): void {
    gen.render();
    lang.render();
  }

  return { root, render };
}

// ── 生成区（PPT 第 3 页「01 生成」）──────────────────────────────

interface Section {
  root: HTMLElement;
  render(): void;
}

function createGenerationSection(deps: StudioPanelDeps): Section {
  const goalInput = el('textarea', {
    id: 'gen-goal',
    class: 'studio-input studio-textarea',
    rows: '2',
    placeholder: '例：给第一次参观的游客做一个 3 分钟讲解，重点介绍整体结构、屋顶和斗拱',
    'aria-label': '讲解目标',
  }) as HTMLTextAreaElement;

  const audienceInput = el('input', {
    id: 'gen-audience',
    class: 'studio-input',
    type: 'text',
    placeholder: '观众（可选），如：第一次参观的游客',
    'aria-label': '观众',
  }) as HTMLInputElement;

  const minutesInput = el('input', {
    id: 'gen-minutes',
    class: 'studio-minutes',
    type: 'number',
    min: '0.5',
    max: '30',
    step: '0.5',
    value: '3',
    'aria-label': '目标时长（分钟）',
  }) as HTMLInputElement;

  const useLlmToggle = el('input', {
    id: 'gen-use-llm',
    type: 'checkbox',
    'aria-label': '使用大语言模型',
  }) as HTMLInputElement;

  const generateButton = el('button', {
    id: 'gen-run',
    class: 'apply-button',
    type: 'button',
    text: '生成讲解草稿',
  });

  const draftHost = el('div', { id: 'gen-draft', class: 'gen-draft', role: 'status', 'aria-live': 'polite' });

  const root = el('section', { class: 'side-section studio-section' }, [
    el('div', { class: 'section-title' }, [
      el('strong', { text: '生成讲解' }),
      el('span', { class: 'live-label', text: '01' }),
    ]),
    el('p', {
      class: 'muted small',
      text: '写清讲解目标和观众，系统会组织知识点、匹配构件、安排顺序，并逐条求解机位。生成结果追加在现有分镜之后——不会覆盖你已经编好的内容。',
    }),
    goalInput,
    audienceInput,
    el('div', { class: 'studio-row' }, [
      el('label', { class: 'studio-inline', for: 'gen-minutes' }, [
        el('span', { text: '时长' }),
        minutesInput,
        el('span', { text: '分钟' }),
      ]),
      el('label', { class: 'studio-inline studio-toggle', for: 'gen-use-llm' }, [
        useLlmToggle,
        el('span', { text: '用大模型' }),
      ]),
    ]),
    generateButton,
    draftHost,
  ]);

  generateButton.addEventListener('click', () => {
    const minutes = Number(minutesInput.value);
    deps.onGenerate({
      goal: goalInput.value,
      audience: audienceInput.value,
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
      useLlm: useLlmToggle.checked,
    });
  });

  function render(): void {
    const state = deps.generation.get();
    generateButton.disabled = state.running;
    generateButton.textContent = state.running ? '正在生成…' : '生成讲解草稿';
    fill(draftHost, [renderDraft(state.draft, state.source, state.error)]);
  }

  function renderDraft(draft: GenerationDraft | null, source: string, error: string | null): Node {
    if (error) return el('div', { class: 'studio-error', role: 'alert', text: error });
    if (!draft) return el('span', { class: 'studio-empty' });

    const adoptButton = el('button', {
      id: 'gen-adopt',
      class: 'apply-button',
      type: 'button',
      text: `采纳这 ${draft.steps.length} 步`,
    });
    adoptButton.disabled = draft.steps.length === 0;
    adoptButton.addEventListener('click', () => deps.onAdoptDraft(draft));

    const discardButton = el('button', {
      id: 'gen-discard',
      class: 'quiet-button',
      type: 'button',
      text: '丢弃',
    });
    discardButton.addEventListener('click', () => deps.onDiscardDraft());

    return el('div', { class: 'draft-box' }, [
      el('div', { class: 'draft-head' }, [
        el('strong', { class: 'draft-title', text: draft.title }),
        el('span', { class: 'draft-source', text: source }),
      ]),
      el('ol', { class: 'draft-steps' }, draft.steps.map((s) => el('li', { class: 'draft-step' }, [
        el('span', { class: 'draft-step-title', text: s.title }),
        el('span', { class: 'draft-step-intent', text: INTENT_LABELS[s.intentKind] }),
        el('span', { class: 'draft-step-dur', text: `${(s.durationMs / 1000).toFixed(1)}s` }),
        s.motionDegrees
          ? el('span', { class: 'draft-step-motion', text: `环绕 ${s.motionDegrees}°` })
          : el('span', { class: 'draft-step-motion' }),
      ]))),
      draft.notes.length > 0
        ? el('ul', { class: 'draft-notes' }, draft.notes.map((n) => el('li', { text: n })))
        : el('span', { class: 'studio-empty' }),
      draft.warnings.length > 0
        ? el('ul', { class: 'draft-warnings', role: 'alert' }, draft.warnings.map((w) => el('li', { text: w })))
        : el('span', { class: 'studio-empty' }),
      el('div', { class: 'draft-actions' }, [adoptButton, discardButton]),
    ]);
  }

  return { root, render };
}

// ── 语言编创区（PPT 第 3 页「03 编辑」）──────────────────────────

function createLanguageSection(deps: StudioPanelDeps): Section {
  const instructionInput = el('input', {
    id: 'lang-instruction',
    class: 'studio-input',
    type: 'text',
    placeholder: '例：把斗拱放到第二步介绍 / 不要隐藏柱子 / 这一步环绕一周',
    'aria-label': '编辑指令',
  }) as HTMLInputElement;

  const parseButton = el('button', {
    id: 'lang-parse',
    class: 'apply-button',
    type: 'button',
    text: '解析这条指令',
  });

  const parsedHost = el('div', { id: 'lang-parsed', class: 'lang-parsed' });

  const feedbackInput = el('input', {
    id: 'lang-feedback',
    class: 'studio-input',
    type: 'text',
    placeholder: '例：这个视角看不清斗拱 / 镜头切换太快 / 柱子应该一直保留',
    'aria-label': '创作反馈',
  }) as HTMLInputElement;

  const feedbackButton = el('button', {
    id: 'lang-feedback-run',
    class: 'apply-button',
    type: 'button',
    text: '提交反馈',
  });

  const feedbackHost = el('div', { id: 'lang-feedback-result', class: 'lang-parsed' });

  const root = el('section', { class: 'side-section studio-section' }, [
    el('div', { class: 'section-title' }, [
      el('strong', { text: '用一句话改' }),
      el('span', { class: 'live-label', text: '03' }),
    ]),
    el('p', {
      class: 'muted small',
      text: '先说一句要改什么。系统先解析、不执行，把它的理解摆给你核对——理解错了就换句话，而不是改了再撤销。',
    }),
    instructionInput,
    parseButton,
    parsedHost,
    el('div', { class: 'studio-divider' }),
    el('div', { class: 'section-title' }, [
      el('strong', { text: '给点反馈' }),
      el('span', { class: 'live-label', text: '反馈' }),
    ]),
    el('p', {
      class: 'muted small',
      text: '反馈不会被拿来猜一个机位就改掉。系统先判断问题出在内容、目标、视角还是节奏上，再给出对应的调法——「讲得太复杂」这类问题它不会替你改写旁白。',
    }),
    feedbackInput,
    feedbackButton,
    feedbackHost,
  ]);

  const submitParse = (): void => deps.onParseInstruction(instructionInput.value);
  parseButton.addEventListener('click', submitParse);
  instructionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitParse();
  });

  const submitFeedback = (): void => deps.onFeedback(feedbackInput.value);
  feedbackButton.addEventListener('click', submitFeedback);
  feedbackInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitFeedback();
  });

  function render(): void {
    const state = deps.language.get();
    fill(parsedHost, [renderParsed(state.parsed), renderOutcomes(state.outcomes)]);
    fill(feedbackHost, [renderFeedback(state.feedback), renderOutcomes(state.feedbackOutcomes)]);
  }

  // ── 执行结果的呈现 ──
  //
  // 「一次说三件事、其中一件没听懂」是常态。逐条列出哪条做了、哪条没做、
  // 为什么没做——**失败的那条必须解释原因**，否则作者只会看到「少了半句话」。
  function renderOutcomes(outcomes: Array<{ ok: boolean; message: string }>): Node {
    if (outcomes.length === 0) return el('span', { class: 'studio-empty' });
    return el('ul', { class: 'outcome-list' }, outcomes.map((o) =>
      el('li', { class: o.ok ? 'outcome-item outcome-ok' : 'outcome-item outcome-fail' }, [
        el('span', { class: 'outcome-mark', text: o.ok ? '✓' : '✗' }),
        el('span', { text: o.message }),
      ]),
    ));
  }

  // ── 解析结果的呈现 ──
  //
  // ★ 这一段是「自然语言与三维操作融合」这条主张的**用户可见证据**：
  //   它把「系统到底听懂了什么」逐条摊开——改什么、置信度多少、以及为什么
  //   这么理解。作者据此决定「执行」还是「换句话」。
  //   一个只显示「已理解」的界面，等于要求作者盲信。

  function renderParsed(parsed: ParseResult | null): Node {
    if (!parsed) return el('span', { class: 'studio-empty' });

    if (parsed.commands.length === 0) {
      // 没听懂时**只说没听懂，不给任何猜测性动作**。evidence 里是命中的证据词，
      // 列出来是为了让作者看清「系统注意到了哪些词但没能组成一条指令」——
      // 这比一句「未识别」有用得多。
      return el('div', { class: 'parse-box parse-empty' }, [
        el('p', {
          class: 'muted small',
          text: '没听懂这条指令。可以说得更具体些，例如指明「第几步」，或说出构件名（斗拱、柱子、屋顶…）。',
        }),
        parsed.evidence.length > 0
          ? el('p', { class: 'parse-unparsed muted small', text: `注意到的线索：${parsed.evidence.join('；')}` })
          : el('span', { class: 'studio-empty' }),
      ]);
    }

    const applyButton = el('button', {
      id: 'lang-apply',
      class: 'apply-button',
      type: 'button',
      text: `执行这 ${parsed.commands.length} 条`,
    });
    applyButton.addEventListener('click', () => deps.onApplyParsed());

    const clearButton = el('button', {
      id: 'lang-clear',
      class: 'quiet-button',
      type: 'button',
      text: '清空',
    });
    clearButton.addEventListener('click', () => deps.onClearParsed());

    return el('div', { class: 'parse-box' }, [
      el('ul', { class: 'parse-list' }, parsed.commands.map((c) => el('li', { class: 'parse-item' }, [
        el('div', { class: 'parse-line' }, [
          el('span', { class: 'parse-kind', text: commandKindLabel(c.kind) }),
          el('span', {
            class: c.confidence >= 0.7 ? 'parse-conf parse-conf-high' : 'parse-conf parse-conf-low',
            text: `置信度 ${(c.confidence * 100).toFixed(0)}%`,
          }),
        ]),
        el('span', { class: 'parse-why', text: c.rationale }),
      ]))),
      el('div', { class: 'draft-actions' }, [applyButton, clearButton]),
    ]);
  }

  // ── 反馈归因的呈现 ──
  //
  // ★ 与解析区同一个立场：**把归因结论和理由都摆出来**。
  //   「这个视角看不清」→ 视图问题 → 重算机位；「讲得太复杂」→ 内容问题 →
  //   不给建议（系统不替作者写旁白）。两者的区别必须在界面上看得见，
  //   否则作者会以为「没反应」是坏了。

  function renderFeedback(feedback: FeedbackResult | null): Node {
    if (!feedback) return el('span', { class: 'studio-empty' });

    // 一条反馈可能同时指向多处（「看不清斗拱而且切换太快」）。全部列出，
    // 让作者自己决定改哪个——系统不替作者排序后只做一个。
    const boxes = feedback.diagnoses.map((diagnosis, index) => {
      const rows: Node[] = [
        el('div', { class: 'diag-head' }, [
          el('span', { class: 'diag-aspect', text: ASPECT_LABELS[diagnosis.aspect] }),
          el('span', {
            class: diagnosis.confidence >= 0.7 ? 'parse-conf parse-conf-high' : 'parse-conf parse-conf-low',
            text: `把握 ${(diagnosis.confidence * 100).toFixed(0)}%`,
          }),
        ]),
        el('p', { class: 'diag-why', text: describeDiagnosis(diagnosis) }),
        el('p', { class: 'diag-reason muted small', text: `判断依据：${diagnosis.evidence.join('；')}` }),
      ];

      if (diagnosis.suggested) {
        const button = el('button', { class: 'apply-button', type: 'button', text: '按这个调一下' });
        button.addEventListener('click', () => deps.onApplyDiagnosis(index));
        rows.push(el('div', { class: 'diag-actions' }, [button]));
      } else {
        // ★ 「系统不替你改」要**明确说出来**并说明为什么。
        //   内容层面的问题（「讲得太复杂」）没有可自动执行的修复动作——
        //   让求解器去改一个不存在的机位、或让模型替你重写旁白，都比不做更糟。
        rows.push(el('p', {
          class: 'diag-none muted small',
          text: diagnosis.aspect === 'content'
            ? '这类问题系统不替你改：讲什么由你决定，没有可以自动执行的动作。建议直接改那一步的旁白。'
            : '这一类没有可以自动执行的动作，需要你手动调整。',
        }));
      }

      return el('div', { class: 'diag-box' }, rows);
    });

    if (boxes.length === 0) {
      return el('div', { class: 'parse-box parse-empty' }, [
        el('p', {
          class: 'muted small',
          text: '没能判断这条反馈指向哪里。可以说得更具体，例如指明「哪一步」「哪个东西不对」。',
        }),
        feedback.evidence.length > 0
          ? el('p', { class: 'parse-unparsed muted small', text: `注意到的线索：${feedback.evidence.join('；')}` })
          : el('span', { class: 'studio-empty' }),
      ]);
    }

    return el('div', { class: 'parse-box' }, boxes);
  }

  return { root, render };
}

/** 指令类型 → 中文标签。放在这里而不是 L3，因为它是**界面措辞**而非业务语义。 */
function commandKindLabel(kind: EditCommand['kind']): string {
  switch (kind) {
    case 'move-step': return '调整位置';
    case 'delete-step': return '删除步骤';
    case 'duplicate-step': return '复制步骤';
    case 'set-intent': return '设置视觉意图';
    case 'set-narration': return '改写旁白';
    case 'set-duration': return '调整时长';
    case 'set-motion': return '设置运镜';
    case 'hide-components': return '隐藏构件';
    case 'keep-components': return '保留构件';
    case 'highlight-components': return '高亮构件';
    case 'retarget': return '换目标构件';
    case 're-solve': return '重算机位';
    default: return '操作';
  }
}
