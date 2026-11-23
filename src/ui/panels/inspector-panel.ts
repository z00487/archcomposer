/**
 * L5 界面层 · M14 构件检查器（视觉操作 + 示范录制控制 + 模型加载）
 *
 * 依据：《项目概要设计文档》§4.1 的 M14、§6.1（示范录制的入口）、FR-11。
 *
 * **这一个面板同时是「编排模式」与「示范模式」的操作台**：
 *  - 编排模式下，透明度/高亮/隐藏直接改当前步骤的视觉状态；
 *  - 示范模式下，同样的操作被 M5 记录成 `DemoAction`。
 *
 * **为什么不在界面上区分两个模式**：因为作者的动作是**一样的**——他就是在调构件。
 * 让他在模式间切换只会增加认知负担。差别由「是否在录制」这个开关决定，
 * 由 L4 的命令层处理。
 */
import type { SelectionStore } from '../../app/stores/stores.ts';
import type { ComponentId } from '../../domain/types/component.ts';
import { el } from '../components/dom.ts';

export interface InspectorDeps {
  selection: SelectionStore;
  labelOf(id: ComponentId): string;
  idOf(id: ComponentId): string;
  /** 当前选中构件的语义摘要（类型/部位），由 L2 提供 */
  semanticsOf(id: ComponentId): { kind: string; part: string; warnings: string[] } | null;

  onOpacity(value: number): void;
  onToggleHighlight(): void;
  onToggleVisible(): void;
  onRestore(): void;

  /** 示范录制 */
  isRecording(): boolean;
  onStartDemo(): void;
  onFinishDemo(): void;
  /** 示范时作者写的旁白（FR-13 的自然语言通道的输入） */
  demoNarration(): string;
  onDemoNarration(text: string): void;

  /** 模型加载 */
  onPickModel(file: File): void;

  /** 新建步骤（把当前视觉状态记入步骤） */
  onCommitToStep(): void;

  /** 存档（FR-10）：保存 / 打开 / 载入示例 */
  onSaveStoryboard(): void;
  onOpenStoryboard(file: File): void;
  onLoadExample(): void;
  /** 保存前的预估信息（「N 个步骤 · 约 M KB」）与阻断原因 */
  saveInfo(): { detail: string; blocked: string[] };
}

export interface InspectorPanel {
  root: HTMLElement;
  render(): void;
  /** 从外部更新透明度滑块的显示（如预览某一步时） */
  setOpacityDisplay(value: number): void;
  setHighlightActive(active: boolean): void;
  setVisibilityLabel(visible: boolean): void;
  setDemoCount(text: string): void;
  /** 刷新存档区的信息与阻断提示 */
  setSaveInfo(info: { detail: string; blocked: string[] }): void;
}

export function createInspectorPanel(deps: InspectorDeps): InspectorPanel {
  const nameNode = el('div', { class: 'selected-name', id: 'selected-name', text: '尚未选择构件' });
  const typeNode = el('div', { class: 'muted', id: 'selected-type', text: '点击场景中的构件开始编辑' });

  const opacitySlider = el('input', {
    id: 'opacity',
    type: 'range',
    min: 10,
    max: 100,
    value: 100,
    disabled: true,
  }) as HTMLInputElement;
  const opacityValue = el('strong', { id: 'opacity-value', text: '100%' });

  const highlightButton = el('button', { class: 'action-button primary', id: 'highlight', type: 'button', disabled: true, text: '✦ 高亮构件' });
  const visibilityButton = el('button', { class: 'action-button', id: 'toggle-visible', type: 'button', disabled: true, text: '◉ 隐藏构件' });
  const restoreButton = el('button', { class: 'restore-button', id: 'restore', type: 'button', disabled: true, text: '恢复该构件默认状态' });

  const narrationInput = el('textarea', {
    id: 'demo-narration',
    class: 'narration-input',
    rows: '2',
    placeholder: '（可选）用一句话描述这一步想讲什么，如「强调这根柱子」',
    'aria-label': '示范旁白',
  }) as HTMLTextAreaElement;
  const demoButton = el('button', { class: 'apply-button', id: 'demo-toggle', type: 'button', text: '● 开始示范录制' });
  const demoCount = el('span', { class: 'demo-count', id: 'demo-count', text: '' });

  const commitButton = el('button', { class: 'quiet-button', id: 'commit-step', type: 'button', text: '把当前视觉状态记入新步骤' });

  const fileInput = el('input', {
    id: 'model-file',
    type: 'file',
    accept: '.glb,.gltf,model/gltf-binary,model/gltf+json',
    hidden: true,
  }) as HTMLInputElement;
  const uploadLabel = el('label', { class: 'upload-button', for: 'model-file', text: '＋ 选择 GLB / GLTF 文件' });

  // ── 存档区（FR-10）──────────────────────────────────────────
  const saveButton = el('button', { class: 'apply-button', id: 'save-storyboard', type: 'button', text: '⤓ 保存分镜' });
  const saveInfoNode = el('p', { class: 'muted small', id: 'save-info', text: '' });
  const saveBlockNode = el('ul', { class: 'save-block-list', id: 'save-block', hidden: true });
  const openInput = el('input', {
    id: 'storyboard-file',
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
  }) as HTMLInputElement;
  const openLabel = el('label', { class: 'upload-button', for: 'storyboard-file', text: '打开分镜文件' });
  const exampleButton = el('button', { class: 'quiet-button', id: 'load-example', type: 'button', text: '载入示例分镜' });

  opacitySlider.addEventListener('input', () => {
    deps.onOpacity(Number(opacitySlider.value) / 100);
  });
  highlightButton.addEventListener('click', () => deps.onToggleHighlight());
  visibilityButton.addEventListener('click', () => deps.onToggleVisible());
  restoreButton.addEventListener('click', () => deps.onRestore());
  narrationInput.addEventListener('input', () => deps.onDemoNarration(narrationInput.value));
  demoButton.addEventListener('click', () => {
    if (deps.isRecording()) deps.onFinishDemo();
    else deps.onStartDemo();
  });
  commitButton.addEventListener('click', () => deps.onCommitToStep());
  saveButton.addEventListener('click', () => deps.onSaveStoryboard());
  exampleButton.addEventListener('click', () => deps.onLoadExample());
  openInput.addEventListener('change', () => {
    const file = openInput.files?.[0];
    if (file) deps.onOpenStoryboard(file);
    openInput.value = '';
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) deps.onPickModel(file);
    fileInput.value = '';
  });

  const root = el('div', {}, [
    el('section', { class: 'side-section selected-section' }, [
      el('div', { class: 'section-title' }, [
        el('strong', { text: '当前构件' }),
        el('span', { class: 'live-label', text: 'LIVE' }),
      ]),
      nameNode,
      typeNode,
      el('div', { class: 'control-block' }, [
        el('div', { class: 'control-label' }, [
          el('label', { for: 'opacity', text: '透明度' }),
          opacityValue,
        ]),
        opacitySlider,
        el('div', { class: 'range-ends' }, [el('span', { text: '更透明' }), el('span', { text: '不透明' })]),
      ]),
      el('div', { class: 'action-grid' }, [highlightButton, visibilityButton]),
      restoreButton,
    ]),
    el('section', { class: 'side-section demo-section' }, [
      el('div', { class: 'section-title' }, [
        el('strong', { text: '示范录制' }),
        demoCount,
      ]),
      el('p', { class: 'muted small', text: '点「开始示范录制」，然后像平时一样选构件、转相机、调透明度。结束后系统会从你的操作里推断意图，交给你确认。' }),
      el('div', { class: 'control-label' }, [
        el('label', { for: 'demo-narration', text: '旁白 / 意图描述' }),
        el('span', { class: 'muted small', text: '参与推断' }),
      ]),
      narrationInput,
      demoButton,
      commitButton,
    ]),
    el('section', { class: 'side-section save-section' }, [
      el('div', { class: 'section-title' }, [el('strong', { text: '分镜存档' })]),
      saveInfoNode,
      saveBlockNode,
      saveButton,
      el('div', { class: 'action-grid' }, [openLabel, exampleButton]),
      openInput,
    ]),
    el('section', { class: 'side-section model-section' }, [
      el('div', { class: 'section-title' }, [el('strong', { text: '加载自定义模型' })]),
      el('p', { class: 'muted small', text: '支持本地 .glb / .gltf 文件。外部模型的构件名通常不合命名规范，语义会显示为 unknown——这是刻意如实告知，而不是猜一个标签。' }),
      uploadLabel,
      fileInput,
    ]),
  ]);

  function render(): void {
    const state = deps.selection.get();
    const id = state.selectedId;
    const enabled = id !== null;

    opacitySlider.disabled = !enabled;
    highlightButton.disabled = !enabled;
    visibilityButton.disabled = !enabled;
    restoreButton.disabled = !enabled;

    if (!id) {
      nameNode.textContent = '尚未选择构件';
      typeNode.textContent = '点击场景中的构件开始编辑';
    } else {
      const semantics = deps.semanticsOf(id);
      nameNode.textContent = deps.labelOf(id);
      typeNode.textContent = semantics
        ? `${semantics.kind === 'unknown' ? 'unknown（不在词表内）' : semantics.kind} · ${semantics.part || '无定位词'}`
        : '';
      typeNode.title = semantics?.warnings.join('\n') ?? '';
    }

    const recording = deps.isRecording();
    demoButton.textContent = recording ? '■ 结束示范并推断意图' : '● 开始示范录制';
    demoButton.classList.toggle('is-recording', recording);
  }

  function setOpacityDisplay(value: number): void {
    opacitySlider.value = String(Math.round(value * 100));
    opacityValue.textContent = `${Math.round(value * 100)}%`;
  }

  function setHighlightActive(active: boolean): void {
    highlightButton.classList.toggle('is-active', active);
  }

  function setVisibilityLabel(visible: boolean): void {
    visibilityButton.textContent = visible ? '◉ 隐藏构件' : '◉ 显示构件';
  }

  function setDemoCount(text: string): void {
    demoCount.textContent = text;
  }

  /// 存档区的信息。**有 error 时保存按钮被禁用**——这是 §4.5「error 阻断、warning 放行」的界面落实
  function setSaveInfo(info: { detail: string; blocked: string[] }): void {
    saveInfoNode.textContent = info.detail;
    const hasBlock = info.blocked.length > 0;
    saveButton.disabled = hasBlock;
    saveBlockNode.hidden = !hasBlock;
    if (hasBlock) {
      saveBlockNode.replaceChildren(
        ...info.blocked.map((message) => el('li', { text: message })),
      );
    } else {
      saveBlockNode.replaceChildren();
    }
  }

  return { root, render, setOpacityDisplay, setHighlightActive, setVisibilityLabel, setDemoCount, setSaveInfo };
}
