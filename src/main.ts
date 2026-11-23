/**
 * 应用入口 —— **只负责装配**（《项目概要设计文档》§7.3）
 *
 * 本文件曾经把 UI 骨架、场景装配、拾取、特效全写在一起（约 280 行）。
 * 现在它的职责收窄到三件事：
 *
 *   1. 创建各层实例；
 *   2. 把依赖接起来（L4 的 CommandContext、L5 各面板的 deps）；
 *   3. 订阅 Store，把状态变化映射成界面重绘。
 *
 * **一条纪律：本文件不写业务逻辑。** 判「红色」是为了什么、什么时候标 stale、
 * 求解失败了怎么办——这些都在 L3/L4 里，这里只把结果呈现出去。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import './style.css';

// L1
import { clonePose } from './core/math.ts';

// L2
import { buildModelGroup, type GeometryFile } from './runtime/generated-model.ts';
import { registerModel, toSceneSummary, searchComponents } from './runtime/model/registry.ts';
import { Viewport } from './runtime/scene/viewport.ts';
import { EffectManager } from './runtime/effects/effects.ts';
import { Picker } from './runtime/picking/picker.ts';
import { DemoRecorder } from './runtime/demo/recorder.ts';

// L3
import { createDefaultRegistry } from './domain/solver/registry.ts';
import { analyzeDemo } from './domain/intent/rules.ts';
import { suggestRemedies, evaluateFidelity } from './domain/fidelity/fidelity.ts';
import type { ConstraintConflict } from './domain/types/solver.ts';
import type { Storyboard } from './domain/types/storyboard.ts';
import { deriveSemantics, modelPrefixFromFileName } from './domain/naming/naming.ts';
import { orbitMotion } from './domain/types/motion.ts';
import { parseEditInstruction } from './domain/language/instructions.ts';
import { diagnoseFeedback } from './domain/language/feedback.ts';

// L4
import { createAppStores, activeStep } from './app/stores/stores.ts';
import * as cmd from './app/commands/commands.ts';
import { computeContextIds } from './domain/solver/context.ts';
import { createPlaybackController } from './app/playback/playback.ts';
import { downloadStoryboard, readStoryboardFile, loadExampleStoryboard, estimateSize } from './app/io/io.ts';
import { parseStoryboard } from './app/io/io.ts';
import { generateDraft } from './app/generate/generate.ts';
import { loadLlmSettings, saveLlmSettings } from './app/llm/settings-store.ts';
import { probeLlmProxy } from './app/llm/client.ts';

// L5
import { byId, fill } from './ui/components/dom.ts';
import { createComponentPanel, createSemanticsView } from './ui/panels/component-panel.ts';
import { createStepPanel } from './ui/panels/step-panel.ts';
import { createInspectorPanel } from './ui/panels/inspector-panel.ts';
import { createStudioPanel } from './ui/panels/studio-panel.ts';
import { createSettingsPanel } from './ui/panels/settings-panel.ts';
import { createTimeline } from './ui/timeline/timeline.ts';
import { createIntentDialog } from './ui/intent/intent-dialog.ts';

// ── 1. 界面骨架 ─────────────────────────────────────────────────

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand-mark">A</div>
    <div class="brand-copy"><strong>ArchComposer</strong><span>建筑三维可视化解说编创</span></div>
    <div class="top-status"><i></i> <span id="model-status">正在载入模型…</span></div>
  </header>
  <main class="workspace">
    <section class="viewport-panel">
      <div class="viewport-head">
        <div><strong>三维场景</strong><span id="scene-subtitle">示例建筑 · 可交互预览</span></div>
        <div class="viewport-status">
          <span id="object-count">构件 0</span>
          <button id="reset-camera" class="quiet-button" type="button">⟲ 重置视角</button>
        </div>
      </div>
      <div id="viewport" class="viewport">
        <div class="viewport-hint">左键拖动旋转 · 滚轮缩放 · 右键平移 · 点击构件选中</div>
        <div id="loading" class="loading">正在构建三维场景…</div>
        <div id="toast" class="toast"></div>
      </div>
      <div class="viewport-footer">
        <span><b class="dot blue"></b> 左键选择构件</span>
        <span><b class="dot orange"></b> 橙色表示当前选中</span>
        <span id="dirty-indicator"></span>
      </div>
      <div id="timeline-host"></div>
    </section>
    <aside class="side-panel">
      <div class="tabs" role="tablist">
        <button class="tab-button active" data-tab="studio" type="button" role="tab">创作</button>
        <button class="tab-button" data-tab="steps" type="button" role="tab">分镜</button>
        <button class="tab-button" data-tab="components" type="button" role="tab">构件</button>
        <button class="tab-button" data-tab="model" type="button" role="tab">模型</button>
      </div>
      <div class="tab-panel" data-panel="studio" id="panel-studio"></div>
      <div class="tab-panel" data-panel="steps" id="panel-steps" hidden></div>
      <div class="tab-panel" data-panel="components" id="panel-components" hidden></div>
      <div class="tab-panel" data-panel="model" id="panel-model" hidden></div>
    </aside>
  </main>
  <footer class="app-footer">
    <span>ArchComposer · Three.js + TypeScript</span>
    <span>阶段二：分镜 · 意图推断 · 意图保持重定向</span>
  </footer>
`;

const viewportHost = byId<HTMLDivElement>('viewport');
const loading = byId<HTMLDivElement>('loading');
const toastNode = byId<HTMLDivElement>('toast');

// ── 2. 各层实例 ─────────────────────────────────────────────────

const viewport = new Viewport(viewportHost);
const effects = new EffectManager();
const picker = new Picker();
const recorder = new DemoRecorder();
const registry = createDefaultRegistry();
const stores = createAppStores();

/** 作者为这次示范写的旁白。它参与意图推断（FR-13），是「状态差异」之外的第二条通道。 */
let demoNarrationText = '';

let toastTimer = 0;
function toast(message: string): void {
  toastNode.textContent = message;
  toastNode.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastNode.classList.remove('show'), 2600);
}

/** 宿主能力：L4 命令层通过它回调 L2/L5，而命令层本身不 import three。 */
const ctx: cmd.CommandContext = {
  stores,
  registry,
  effects,
  refOf(id) {
    const component = picker.byId(id);
    return component ? { id: component.id, semantics: component.semantics } : null;
  },
  labelOf(id) {
    const component = picker.byId(id);
    return component ? component.displayName : id;
  },
  applyCamera(pose) {
    viewport.setPose(pose);
    stores.camera.set((s) => ({ ...s, pose: clonePose(pose) }));
  },
  focusOn(id) {
    const component = picker.byId(id);
    if (!component) return;
    const { min, max } = component.aabb;
    viewport.setTarget([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]);
  },
  toast,
};

// ── 3. L5 面板 ──────────────────────────────────────────────────

const semanticSearch = { query: '' };
let currentLabelOf = (id: string): string => id;

const componentPanel = createComponentPanel({
  selection: stores.selection,
  list: () => {
    const model = picker.model;
    if (!model) return [];
    return searchComponents(model, semanticSearch.query);
  },
  onPick: (id) => pickComponent(id),
  onSearch: (query) => {
    semanticSearch.query = query;
  },
  labelOf: (id) => currentLabelOf(id),
  statusOf: (id) => {
    const step = activeStep(stores.storyboard.get());
    if (step && step.target.form === 'single' && step.target.component.id === id) return '步骤目标';
    if (step && step.target.form === 'relation' && (step.target.from.id === id || step.target.to.id === id)) return '步骤目标';
    return '';
  },
});

const semanticsView = createSemanticsView();

const stepPanel = createStepPanel({
  storyboard: stores.storyboard,
  selection: stores.selection,
  scene: stores.scene,
  labelOf: (id) => currentLabelOf(id),
  onAddStep: () => {
    const stepId = cmd.addStepFromSelection(ctx);
    if (stepId) refreshAll();
  },
  onDeleteStep: (id) => {
    cmd.deleteStep(ctx, id);
    refreshAll();
  },
  onDuplicateStep: (id) => {
    cmd.duplicateStep(ctx, id);
    refreshAll();
  },
  onMoveStep: (from, to) => {
    cmd.moveStep(ctx, from, to);
    refreshAll();
  },
  onSelectStep: (id) => {
    cmd.setActiveStep(ctx, id);
    const step = activeStep(stores.storyboard.get());
    if (step?.camera) playback.previewStep(stores.storyboard.get().storyboard.steps.findIndex((s) => s.id === id));
    refreshAll();
  },
  onRedirectStep: (id, candidateId) => {
    // 指定了候选（点了失败区里的 chip）→ 就换成那一个；
    // 没指定（工具条上的按钮）→ 取排序第一的候选（命名规范 §7.3 的推荐顺序）
    let target = candidateId;
    if (!target) {
      const candidates = cmd.candidateCandidates(ctx, id);
      if (candidates.length === 0) {
        toast('没有找到可替换的同类构件');
        return;
      }
      target = candidates[0];
    }
    const result = cmd.replaceWithSameKind(ctx, id, target);
    reportRedirect(result);
    refreshAll();
  },
  onSolveStep: (id) => {
    cmd.solveStep(ctx, id);
    refreshAll();
  },
  onPreviewStep: (id) => {
    const steps = stores.storyboard.get().storyboard.steps;
    playback.previewStep(steps.findIndex((s) => s.id === id));
    refreshAll();
  },
  onSetIntent: (id, kind) => {
    cmd.setManualIntent(ctx, id, kind as never);
    refreshAll();
  },
  onUpdateText: (id, patch) => {
    cmd.updateStepText(ctx, id, patch);
    refreshAll();
  },
  onSetMotion: (id, degrees) => {
    cmd.setStepMotion(ctx, id, degrees === null ? null : orbitMotion(degrees));
    refreshAll();
  },
  candidates: (id) => cmd.candidateCandidates(ctx, id),
  failureInfo: (id) => failureInfoOf(id),
});

const inspectorDeps: Parameters<typeof createInspectorPanel>[0] = {
  selection: stores.selection,
  labelOf: (id) => currentLabelOf(id),
  idOf: (id) => id,
  semanticsOf: (id) => {
    const component = picker.byId(id);
    if (!component) return null;
    const report = picker.model?.nameReport;
    const warnings = report?.entries.find((e) => e.nodeName === component.nodeName)?.warnings ?? [];
    return { kind: component.semantics.kind, part: component.semantics.part, warnings };
  },
  onOpacity: (value) => {
    const id = stores.selection.get().selectedId;
    if (!id) return;
    const component = picker.byId(id);
    if (!component) return;
    effects.setOpacity(component.object, value);
    if (recorder.recording) recorder.setOpacity(id, value);
    inspector.setOpacityDisplay(value);
  },
  onToggleHighlight: () => {
    const id = stores.selection.get().selectedId;
    if (!id) return;
    const component = picker.byId(id);
    if (!component) return;
    const enable = !effects.isHighlighted(component.object);
    effects.setHighlight(component.object, enable);
    if (recorder.recording) recorder.setHighlight(id, enable);
    inspector.setHighlightActive(enable);
  },
  onToggleVisible: () => {
    const id = stores.selection.get().selectedId;
    if (!id) return;
    const component = picker.byId(id);
    if (!component) return;
    const visible = !component.object.visible;
    effects.setVisible(component.object, visible);
    if (recorder.recording) recorder.setVisibility(id, visible);
    inspector.setVisibilityLabel(visible);
    componentPanel.render();
  },
  onRestore: () => {
    const id = stores.selection.get().selectedId;
    if (!id) return;
    const component = picker.byId(id);
    if (!component) return;
    effects.restore(component.object);
    selectComponent(id);
    toast('已恢复该构件的默认状态');
  },
  isRecording: () => recorder.recording,
  demoNarration: () => demoNarrationText,
  onDemoNarration: (text) => {
    demoNarrationText = text;
  },
  onStartDemo: () => {
    recorder.start();
    stores.demo.set((s) => ({ ...s, recording: true, actionCount: 0, pending: null }));
    toast('示范录制已开始：选构件、转相机、调透明度，完成后点「结束示范」');
    refreshAll();
  },
  onFinishDemo: () => {
    const outcome = recorder.stop(viewport.getPose());
    if (!outcome) return;
    const scene = stores.scene.get().summary;
    if (!scene) return;
    // ★ FR-13 的自然语言通道：把作者写的旁白一并交给推断，
    //   与「状态差异」这条通道并列——两条通道都进 signals，由打分统一权衡
    const bundle = analyzeDemo(outcome.outcome, scene, demoNarrationText);
    stores.demo.set((s) => ({ ...s, lastRecord: outcome.record }));
    cmd.finishDemo(ctx, { ...bundle, outcome: outcome.outcome });
    intentDialog.open({ ...bundle, outcome: outcome.outcome });
    refreshAll();
  },
  onPickModel: (file) => loadExternalModel(file),

  // ── 存档（FR-10）────────────────────────────────────────────
  onSaveStoryboard: () => {
    const validation = cmd.validateCurrent(ctx);
    if (validation.errors.length > 0) {
      // §4.5：error 阻断保存，且必须把每一条都说清楚
      toast(`保存被阻断：${validation.errors[0]}`);
      refreshAll();
      return;
    }
    cmd.stampModelRef(ctx);
    const board = stores.storyboard.get().storyboard;
    downloadStoryboard(board);
    toast(
      validation.warnings.length > 0
        ? `已保存（有 ${validation.warnings.length} 条提示：${validation.warnings[0]}）`
        : `已保存分镜「${board.title}」`,
    );
  },
  onOpenStoryboard: (file) => {
    void readStoryboardFile(file).then((result) => {
      if (!result.ok || !result.storyboard) {
        toast(`打开失败：${result.errors[0] ?? '未知原因'}`);
        return;
      }
      adoptStoryboard(result.storyboard);
      toast(
        result.warnings.length > 0
          ? `已打开，但有 ${result.warnings.length} 条提示：${result.warnings[0]}`
          : `已打开分镜「${result.storyboard.title}」`,
      );
    });
  },
  onLoadExample: () => {
    void loadExampleStoryboard().then((result) => {
      if (!result.ok || !result.storyboard) {
        toast(`示例分镜载入失败：${result.errors[0] ?? '未知原因'}`);
        return;
      }
      adoptStoryboard(result.storyboard);
      toast('已载入示例分镜');
    });
  },
  saveInfo: () => {
    const validation = cmd.validateCurrent(ctx);
    const board = stores.storyboard.get().storyboard;
    const stats = derivedStats(board.steps);
    return {
      detail: `${stats.total} 个步骤 · 已求解 ${stats.solved} / 待重算 ${stats.stale} / 失败 ${stats.failed} · 约 ${(estimateSize(board) / 1024).toFixed(1)} KB`,
      blocked: validation.errors,
    };
  },
  onCommitToStep: () => {
    const id = stores.selection.get().selectedId;
    if (!id) {
      toast('请先选择一个构件');
      return;
    }
    const stepId = cmd.addStepFromSelection(ctx);
    if (!stepId) return;
    // 把当前的视觉状态（高亮/透明度/隐藏）写进这一步
    const captured = effects.capture();
    const step = stores.storyboard.get().storyboard.steps.find((s) => s.id === stepId);
    if (step) {
      cmd.updateStepText(ctx, stepId, { title: step.title });
      const next = {
        ...stores.storyboard.get().storyboard,
        steps: stores.storyboard.get().storyboard.steps.map((s) =>
          s.id === stepId
            ? { ...s, effects: captured, camera: viewport.getPose(), solve: 'solved' as const, solveNote: '机位与视觉状态来自当前视口' }
            : s,
        ),
      };
      stores.storyboard.set((s) => ({ ...s, storyboard: next }));
    }
    toast('已把当前视觉状态记入新步骤');
    refreshAll();
  },
};

const inspector = createInspectorPanel(inspectorDeps);

const timeline = createTimeline({
  storyboard: stores.storyboard,
  playback: stores.playback,
  onPlay: () => {
    playback.play(0);
    refreshAll();
  },
  onPause: () => {
    playback.pause();
    refreshAll();
  },
  onStop: () => {
    playback.stop();
    refreshAll();
  },
  onSeek: (index) => {
    playback.previewStep(index);
    refreshAll();
  },
});

const playback = createPlaybackController({
  playback: stores.playback,
  camera: stores.camera,
  storyboard: stores.storyboard,
  effects,
  viewport,
  scene: () => stores.scene.get().summary,
});

const intentDialog = createIntentDialog({
  onAccept: (prediction) => {
    cmd.acceptPrediction(ctx, prediction);
    intentDialog.close();
    refreshAll();
  },
  onManual: (kind) => {
    // 「手动选择」这条路：直接给当前选中构件建一个新步骤
    cmd.addStepFromSelection(ctx);
    const steps = stores.storyboard.get().storyboard.steps;
    const newest = steps[steps.length - 1];
    if (newest) {
      cmd.setManualIntent(ctx, newest.id, kind as never);
      cmd.solveStep(ctx, newest.id);
    }
    intentDialog.close();
    refreshAll();
  },
  onSkip: () => {
    intentDialog.close();
    toast('已跳过意图指定，可稍后在步骤面板里选择');
    refreshAll();
  },
});


// ── 生成 / 语言编创面板（PPT 第 3 页「01 生成 · 03 编辑」）────────

/**
 * 面板的 deps 里有**六条**回调，它们共同回答一个问题：
 * 「作者说了一句话之后，从解析到落库之间发生了什么？」
 *
 * 这里刻意把「解析」与「执行」分成两个动作，中间隔着界面上的确认：
 *  - `onParseInstruction` 只解析 → 写进 language store → 作者核对；
 *  - `onApplyParsed` 才真正执行。
 *
 * **为什么不一步到位直接执行**：自然语言指令必然有理解错的概率。一步到位意味着
 * 作者要先看着它改错、再自己撤销——撤销还得先想清楚「它刚才到底改了什么」。
 * 中间加一次确认，把纠错的成本从「撤销」降到「重说一句」。
 */
const studioPanel = createStudioPanel({
  generation: stores.generation,
  language: stores.language,

  onGenerate: (input) => {
    stores.generation.set((s) => ({ ...s, running: true, error: null }));
    void generateDraft(input, {
      scene: () => stores.scene.get().summary,
      settings: () => stores.settings.get().llm,
    })
      .then((outcome) => {
        stores.generation.set(() => ({
          running: false,
          draft: outcome.draft,
          source: outcome.source,
          error: null,
        }));
      })
      .catch((err: unknown) => {
        // 生成通道内部已经把「网络失败」降级成规则生成；能走到这里的只有
        // 真正的程序性错误，因此如实报出来而不是吞掉
        stores.generation.set((s) => ({
          ...s,
          running: false,
          error: `生成失败：${err instanceof Error ? err.message : String(err)}`,
        }));
      });
  },

  onAdoptDraft: (draft) => {
    const outcome = cmd.adoptDraft(ctx, draft, { title: draft.title });
    // 被跳过的步骤 / 求解失败的步骤「必须让作者看见」，否则他会以为生成结果完整。
    // 报在生成区（草稿原来的位置）而不是别处：刚点完「采纳」的目光就在那里，
    // 报在隔着两段的面板下面等于没报。
    stores.generation.set(() => ({
      running: false,
      draft: null,
      source: '',
      error: outcome.needsAttention ? outcome.messages.join('；') : null,
    }));
    refreshAll();
  },

  onDiscardDraft: () => {
    stores.generation.set((s) => ({ ...s, draft: null, error: null }));
    refreshAll();
  },

  onParseInstruction: (text) => {
    const parsed = parseEditInstruction(text, {
      scene: stores.scene.get().summary,
      storyboard: stores.storyboard.get().storyboard,
      activeStepId: stores.storyboard.get().activeStepId,
      labelOf: (id) => currentLabelOf(id),
    });
    stores.language.set((s) => ({ ...s, parsed, outcomes: [] }));
    refreshAll();
  },

  onApplyParsed: () => {
    const parsed = stores.language.get().parsed;
    if (!parsed) return;
    const outcomes = cmd.applyInstructions(ctx, parsed.commands, {
      activeStepId: stores.storyboard.get().activeStepId,
    });
    stores.language.set((s) => ({
      ...s,
      parsed: null,
      outcomes: outcomes.map((o) => ({ ok: o.ok, message: o.message })),
    }));
    refreshAll();
  },

  onClearParsed: () => {
    stores.language.set((s) => ({ ...s, parsed: null, outcomes: [] }));
    refreshAll();
  },

  onFeedback: (text) => {
    const feedback = diagnoseFeedback(text, {
      scene: stores.scene.get().summary,
      storyboard: stores.storyboard.get().storyboard,
      activeStepId: stores.storyboard.get().activeStepId,
    });
    stores.language.set((s) => ({ ...s, feedback, feedbackOutcomes: [] }));
    refreshAll();
  },

  onApplyDiagnosis: (index) => {
    const diagnosis = stores.language.get().feedback?.diagnoses[index];
    if (!diagnosis) return;
    const outcome = cmd.applyFeedback(ctx, diagnosis, {
      activeStepId: stores.storyboard.get().activeStepId,
    });
    // 写在**反馈区自己**的结果槽里（不是指令区那个），作者点完按钮立刻能看见
    stores.language.set((s) => ({
      ...s,
      feedbackOutcomes: [{ ok: outcome.ok, message: outcome.message }],
    }));
    refreshAll();
  },

  onQuickOrbit: (degrees) => {
    const step = activeStep(stores.storyboard.get());
    if (!step) {
      toast('请先在分镜里选中一个步骤');
      return;
    }
    cmd.setStepMotion(ctx, step.id, orbitMotion(degrees));
    refreshAll();
  },
});

// ── 大模型设置面板 ───────────────────────────────────────────────

const settingsPanel = createSettingsPanel({
  settings: stores.settings,

  onSave: (patch) => {
    const current = stores.settings.get().llm;
    const next = { ...current, ...patch };
    const persisted = saveLlmSettings(next);
    stores.settings.set((s) => ({
      ...s,
      llm: next,
      // 保存后旧的探活结果就作废了（地址或 key 可能变了）
      proxyReachable: null,
      proxyHasKey: false,
      proxyNote: persisted
        ? '已保存。再「检测代理」确认一下连通性。'
        : '设置已生效，但没能写进浏览器本地存储（隐私模式？），刷新后会丢失。',
    }));
    refreshAll();
  },

  onProbe: () => {
    const endpoint = stores.settings.get().llm.endpoint;
    stores.settings.set((s) => ({ ...s, proxyNote: '正在检测…' }));
    void probeLlmProxy(endpoint).then((result) => {
      stores.settings.set((s) => ({
        ...s,
        proxyReachable: result.reachable,
        proxyHasKey: result.hasServerKey,
        proxyNote: result.note,
      }));
      refreshAll();
    });
  },
});

// ── 4. 行为 ─────────────────────────────────────────────────────
function pickComponent(id: string | null): void {
  selectComponent(id);
  const step = activeStep(stores.storyboard.get());
  if (recorder.recording) {
    if (id) recorder.select(id);
    else recorder.deselect();
  }
  void step;
}

function selectComponent(id: string | null): void {
  stores.selection.set((s) => ({ ...s, selectedId: id }));

  const component = id ? picker.byId(id) : null;
  if (component) {
    const material = (component.object as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    inspector.setOpacityDisplay(material?.opacity ?? 1);
    inspector.setHighlightActive(effects.isHighlighted(component.object));
    inspector.setVisibilityLabel(component.object.visible);
  }
  inspector.render();
}

/** 报告重定向的结果（FR-18 / FR-19 的界面反馈）。 */
function reportRedirect(result: { ok: boolean; fidelity: number; warnings: string[]; conflicts: string[] }): void {
  if (result.warnings.length > 0) {
    // 非同类构件的警告必须让用户看到（§6.2 步骤 ⑦）
    toast(result.warnings[0]);
    return;
  }
  if (result.ok) {
    toast(`已按原意图重解，保真度 ${Math.round(result.fidelity * 100)}%`);
  } else if (result.conflicts.length > 0) {
    toast(`重解未通过：${result.conflicts[0]}`);
  }
}

/** 取出某步骤的失败详情（冲突清单 + 替代建议）。 */
function failureInfoOf(stepId: string): { conflicts: ConstraintConflict[]; remedies: string[]; note: string } | null {
  const step = stores.storyboard.get().storyboard.steps.find((s) => s.id === stepId);
  if (!step) return null;
  if (step.solve !== 'failed' && step.solve !== 'stale') return null;

  const scene = stores.scene.get().summary;
  const intent = step.intent;
  if (!scene || !intent) {
    return { conflicts: [], remedies: [], note: step.solveNote ?? '需要重算' };
  }

  // 用保真度模块重算一次当前状态的评估，拿到冲突清单与建议。
  // **注意这里不改任何数据**——只是「按当前机位（或默认机位）算一遍分数」。
  const pose = step.camera ?? viewport.getPose();
  const contextIds = computeContextIds(step.target, scene);
  const { report } = evaluateFidelity(
    { intent, target: step.target, pose, effects: step.effects, scene },
    contextIds,
  );
  return {
    conflicts: report.conflicts,
    remedies: suggestRemedies(report, scene, intent),
    note: step.solveNote ?? '需要重算',
  };
}

// ── 5. 模型加载 ─────────────────────────────────────────────────

/** 注册一棵模型树并把所有下游状态刷新到「新模型」的状态。 */
function adoptModel(root: THREE.Object3D, prefix: string, label: string, keepOrigin: boolean): void {
  viewport.frame(root, keepOrigin);
  const model = registerModel(root, prefix, label, [viewport.ground]);
  effects.attach(model);
  picker.attach(model, effects);
  recorder.attach(model);

  stores.model.set(() => ({
    prefix: model.prefix,
    label,
    componentCount: model.components.length,
    nameWarningCount: model.nameReport.warnings.length,
    duplicateCount: model.nameReport.duplicates.length,
    ready: true,
  }));

  syncSceneSummary();
  byId<HTMLElement>('scene-subtitle').textContent = label;
  byId<HTMLElement>('object-count').textContent = `构件 ${model.components.length}`;
  byId<HTMLElement>('model-status').textContent =
    `${model.components.length} 个构件 · 语义告警 ${model.nameReport.warnings.length}`;
  loading.classList.add('hidden');

  selectComponent(null);

  // 加载报告里有重复构件名时**必须让用户知道**：重复名意味着 ID 会冲突，
  // 也就是「重定向时可能换错构件」（规范 §7.4 把重复列为阻断项）
  if (model.nameReport.duplicates.length > 0) {
    toast(`模型里有 ${model.nameReport.duplicates.length} 个重复构件名，稳定 ID 会冲突，请修正命名`);
  }

  // 分镜与模型兼容性检查（支撑 C-3）
  const compatibility = cmd.checkCompatibility(ctx);
  if (!compatibility.compatible) {
    byId<HTMLElement>('dirty-indicator').textContent = '⚠ 当前分镜与模型不匹配';
    toast(compatibility.reason);
  } else {
    byId<HTMLElement>('dirty-indicator').textContent = '';
  }

  refreshAll();
}

function syncSceneSummary(): void {
  const model = picker.model;
  if (!model) {
    stores.scene.set(() => ({ summary: null }));
    return;
  }
  stores.scene.set(() => ({ summary: toSceneSummary(model, viewport.aspect) }));
  stores.camera.set((s) => ({ ...s, aspect: viewport.aspect, pose: viewport.getPose() }));
}

function loadGeneratedHall(): void {
  fetch(`${import.meta.env.BASE_URL}models/demohall.geometry.json`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<GeometryFile>;
    })
    .then((file) => {
      adoptModel(
        buildModelGroup(file),
        file.prefix,
        `程序生成厅堂 · ${file.components.length} 个构件 · 构件名遵循命名规范`,
        true,
      );
      toast('已加载程序生成的厅堂模型');
    })
    .catch((err) => {
      console.error(err);
      loading.classList.add('hidden');
      byId<HTMLElement>('model-status').textContent = '模型载入失败';
      toast('未找到 demohall.geometry.json，请先运行 npm run gen:model');
    });
}

function loadExternalModel(file: File): void {
  const url = URL.createObjectURL(file);
  loading.classList.remove('hidden');
  loading.textContent = `正在加载 ${file.name}…`;
  const prefix = modelPrefixFromFileName(file.name);

  new GLTFLoader().load(
    url,
    (gltf) => {
      adoptModel(
        gltf.scene,
        prefix,
        `${file.name} · 外部模型（构件名多半不合规范，语义会显示为 unknown）`,
        false,
      );
      URL.revokeObjectURL(url);
      toast('模型加载成功');
    },
    undefined,
    (error) => {
      console.error(error);
      loading.classList.add('hidden');
      toast('模型加载失败，请检查文件格式');
      URL.revokeObjectURL(url);
    },
  );
}

/** 步骤统计（存档区显示用）。放在这里而不是 L3，因为它只是界面的措辞。 */
function derivedStats(steps: ReadonlyArray<{ solve: string }>): {
  total: number;
  solved: number;
  stale: number;
  failed: number;
} {
  const stats = { total: steps.length, solved: 0, stale: 0, failed: 0 };
  for (const step of steps) {
    if (step.solve === 'solved') stats.solved += 1;
    else if (step.solve === 'stale') stats.stale += 1;
    else if (step.solve === 'failed') stats.failed += 1;
  }
  return stats;
}

/**
 * 载入一份分镜，并**检查它与当前模型的兼容性**。
 *
 * 兼容性检查放在这里而不是 IO 层，因为只有这里同时拿得到「分镜」与「当前模型」
 * （概要设计 §3.4 / C-3）。不兼容时不拒绝加载——让用户看到内容、知道哪里对不上，
 * 比打不开有用——但必须明确提示。
 */
function adoptStoryboard(board: Storyboard): void {
  const previous = stores.storyboard.get();
  stores.storyboard.set(() => ({
    ...previous,
    storyboard: board,
    activeStepId: board.steps[0]?.id ?? null,
    dirty: false,
  }));
  const compatibility = cmd.checkCompatibility(ctx);
  if (!compatibility.compatible) {
    byId<HTMLElement>('dirty-indicator').textContent = '⚠ 当前分镜与模型不匹配';
    toast(compatibility.reason);
  }
  // 载入后把视口移到第一个步骤的机位，用户能立刻看到内容
  const first = board.steps.find((step) => step.camera);
  if (first?.camera) {
    viewport.setPose(first.camera);
    effects.apply(first.effects);
  }
  refreshAll();
}

// ── 6. 界面刷新 ─────────────────────────────────────────────────

function refreshAll(): void {
  componentPanel.render();
  stepPanel.render();
  inspector.render();
  timeline.render();
  studioPanel.render();
  settingsPanel.render();

  const component = stores.selection.get().selectedId ? picker.byId(stores.selection.get().selectedId!) : null;
  const entry = component
    ? picker.model?.nameReport.entries.find((e) => e.nodeName === component.nodeName)
    : undefined;
  semanticsView.update(component, component?.id ?? '', entry?.warnings ?? []);

  inspector.setDemoCount(recorder.recording ? `已记录 ${recorder.actionCount} 次操作` : '');
  inspector.setSaveInfo(inspectorDeps.saveInfo());
}

// ── 7. 事件绑定 ─────────────────────────────────────────────────

viewport.domElement.addEventListener('pointerdown', (event) => {
  const hit = picker.pick(event, viewport.domElement, viewport.camera);
  pickComponent(hit?.id ?? null);
});

byId<HTMLButtonElement>('reset-camera').addEventListener('click', () => {
  const model = picker.model;
  if (!model) return;
  viewport.resetView(model.root);
  syncSceneSummary();
  toast('已重置相机视角');
});

// 标签页切换
document.querySelectorAll<HTMLButtonElement>('.tab-button').forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab!;
    document.querySelectorAll<HTMLButtonElement>('.tab-button').forEach((b) =>
      b.classList.toggle('active', b === button),
    );
    document.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });
    // 切到构件页时刷一次列表：期间可能发生了求解/预览，导致「步骤目标」标记变化
    refreshAll();
  });
});

window.addEventListener('resize', () => {
  viewport.resize();
  syncSceneSummary();
});

// 渲染循环
function animate(): void {
  requestAnimationFrame(animate);
  // 录制中持续采样相机（M5 内部有抽稀，不会逐帧堆积）
  if (recorder.recording) {
    recorder.sampleCamera(viewport.getPose());
    stores.demo.set((s) =>
      s.actionCount === recorder.actionCount ? s : { ...s, actionCount: recorder.actionCount },
    );
  }
  viewport.render();
}

// ── 8. 面板挂载 ─────────────────────────────────────────────────

// ★ 生成与语言编创放在第一个标签页，因为它是**流程的第一跳**（PPT 第 5 页）：
//   作者的入口是「说一句要什么」，不是「手搓第一步」。放在最后等于把它藏起来。
fill(byId('panel-studio'), [studioPanel.root]);
fill(byId('panel-steps'), [stepPanel.root]);
fill(byId('panel-components'), [semanticsView.root, componentPanel.root]);
fill(byId('panel-model'), [settingsPanel.root, inspector.root]);
fill(byId('timeline-host'), [timeline.root]);
document.body.append(intentDialog.root);

// ── 9. 订阅（L4 的 Store 是唯一真源，L5 只订阅）───────────────────

stores.storyboard.subscribe((state, prev) => {
  if (state.storyboard !== prev.storyboard) {
    byId<HTMLElement>('dirty-indicator').textContent = state.storyboard.steps.some((s) => s.solve === 'stale')
      ? '⚠ 有步骤待重算'
      : '';
  }
});
stores.playback.subscribe(() => timeline.render());
stores.selection.subscribe(() => refreshAll());
// 生成与语言这两个 Store 的变化**全部**来自异步回调（生成要等网络、探活要等
// 请求），因此统一用订阅驱动重绘，而不是让每个回调各自记得调一次 `refreshAll`——
// 「漏调一次就一直显示转圈」是这类界面最常见的 bug。
stores.generation.subscribe(() => studioPanel.render());
stores.language.subscribe(() => studioPanel.render());
stores.settings.subscribe(() => settingsPanel.render());

// ── 10. 启动 ────────────────────────────────────────────────────

// `currentLabelOf` 在面板创建时就被捕获（闭包），所以必须先它一步设好真实实现
currentLabelOf = (id) => picker.byId(id)?.displayName ?? id;

// 设置从浏览器本地存储读回来（没有就用默认值）。这一句必须在
// `settingsPanel.render()` 之前执行，否则界面会先把默认值画一遍再跳变。
const savedLlm = loadLlmSettings();
stores.settings.set((s) => ({
  ...s,
  llm: savedLlm,
  proxyNote: savedLlm.apiKey
    ? '已从浏览器本地存储读回设置（含 key）。建议改为在服务端配置环境变量。'
    : '尚未探活。点「检测代理」看看 /api/llm 是否就绪。',
}));

viewport.resize();
animate();
loadGeneratedHall();
refreshAll();

// 启动时自动探一次代理：作者打开「大模型设置」就能看到结论，
// 而不是先勾选「用大模型」、等 60 秒、再看一句报错。
void probeLlmProxy(stores.settings.get().llm.endpoint).then((result) => {
  stores.settings.set((s) => ({
    ...s,
    proxyReachable: result.reachable,
    proxyHasKey: result.hasServerKey,
    proxyNote: result.note,
  }));
  settingsPanel.render();
});

// 暴露给控制台，方便答辩时现场演示（`__arch` 是刻意的调试入口，不是 API）
Object.assign(window, { __arch: { stores, ctx, registry, picker, effects, viewport, recorder, cmd } });
// 说明：示例分镜**不自动加载**——自动载入会覆盖用户正在编的内容。
// 入口在「分镜存档」区的「载入示例分镜」按钮上（见 inspector 的 onLoadExample）。
void deriveSemantics;
void parseStoryboard;
