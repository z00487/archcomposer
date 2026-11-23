/**
 * L4 应用层 · M10 Store（应用状态真源）
 *
 * 依据：《项目概要设计文档》§3.4「L4 的 Store 是唯一的状态真源，L5 订阅它」、
 * §4.1 的 M10。
 *
 * **一条纪律：L5（UI）绝不自己保存业务状态。** 它只订阅、只发命令。这样做的
 * 直接好处是「取消/重做」「换模型重载」「播放中被编辑」这三种情形的状态一致性
 * 只需要在 L4 一个地方保证。
 */
import { Store } from '../../core/store.ts';
import type { ComponentId } from '../../domain/types/component.ts';
import type { Storyboard, StoryboardStep, SolveState } from '../../domain/types/storyboard.ts';
import { createStoryboard } from '../../domain/types/storyboard.ts';
import type { SceneSummary } from '../../domain/types/solver.ts';
import type { Pose } from '../../domain/types/geometry.ts';
import type { PredictionBundle } from '../../domain/types/storyboard.ts';
import type { DemoRecord } from '../../domain/types/storyboard.ts';

// ── 分镜 Store ─────────────────────────────────────────────────

export interface StoryboardState {
  storyboard: Storyboard;
  /** 当前选中的步骤（UI 高亮 + 重定向操作的对象） */
  activeStepId: string | null;
  /** 被标记为「需要重算」的步骤是否显示在待办区 */
  dirty: boolean;
}

export function createStoryboardStore(): Store<StoryboardState> {
  return new Store<StoryboardState>(
    { storyboard: createStoryboard('入口厅堂讲解'), activeStepId: null, dirty: false },
    'storyboard',
  );
}

export type StoryboardStore = Store<StoryboardState>;

// ── 选中 Store ─────────────────────────────────────────────────

export interface SelectionState {
  /** 当前选中的构件 ID（场景拾取或列表点击） */
  selectedId: ComponentId | null;
  /** 悬停的构件 ID */
  hoveredId: ComponentId | null;
}

export function createSelectionStore(): Store<SelectionState> {
  return new Store<SelectionState>({ selectedId: null, hoveredId: null }, 'selection');
}

export type SelectionStore = Store<SelectionState>;

// ── 模型 Store ─────────────────────────────────────────────────

export interface ModelState {
  prefix: string;
  label: string;
  componentCount: number;
  /** 语义解析报告里的警告数（外部 GLB 通常很多） */
  nameWarningCount: number;
  duplicateCount: number;
  ready: boolean;
}

export function createModelStore(): Store<ModelState> {
  return new Store<ModelState>(
    { prefix: '', label: '尚未加载模型', componentCount: 0, nameWarningCount: 0, duplicateCount: 0, ready: false },
    'model',
  );
}

export type ModelStore = Store<ModelState>;

// ── 场景摘要 Store（L2 → L3 的几何通道）────────────────────────

export interface SceneState {
  summary: SceneSummary | null;
}

export function createSceneStore(): Store<SceneState> {
  return new Store<SceneState>({ summary: null }, 'scene');
}

export type SceneStore = Store<SceneState>;

// ── 示范录制 Store ─────────────────────────────────────────────

export interface DemoState {
  recording: boolean;
  /** 录制期间的操作条数，UI 上显示「已记录 N 步操作」 */
  actionCount: number;
  /** 最近一次分析产出的候选意图（FR-14 的对话框数据源） */
  pending: PredictionBundle | null;
  /** 最近一次完整的录制记录 */
  lastRecord: DemoRecord | null;
}

export function createDemoStore(): Store<DemoState> {
  return new Store<DemoState>(
    { recording: false, actionCount: 0, pending: null, lastRecord: null },
    'demo',
  );
}

export type DemoStore = Store<DemoState>;

// ── 播放 Store ─────────────────────────────────────────────────

export interface PlaybackState {
  playing: boolean;
  /** 当前播放到的步骤下标；-1 表示未播放 */
  index: number;
  /** 播放中被暂停的原因（如「该步骤尚未求解」），null 表示正常 */
  blockedReason: string | null;
  /** 播放时同步显示的旁白文本 */
  narration: string;
}

export function createPlaybackStore(): Store<PlaybackState> {
  return new Store<PlaybackState>(
    { playing: false, index: -1, blockedReason: null, narration: '' },
    'playback',
  );
}

export type PlaybackStore = Store<PlaybackState>;

// ── 相机 Store（当前视口位姿，供求解器取种子）──────────────────

export interface CameraState {
  pose: Pose | null;
  /** 视口宽高比，SolveRequest 的 SceneSummary 需要它 */
  aspect: number;
}

export function createCameraStore(): Store<CameraState> {
  return new Store<CameraState>({ pose: null, aspect: 1 }, 'camera');
}

export type CameraStore = Store<CameraState>;

// ── 生成 Store（PPT 第 3 页「01 生成」的界面状态）────────────────

export interface GenerationState {
  /** 是否正在生成（按钮转圈、禁止重复点） */
  running: boolean;
  /** 最近一次生成的草稿（预览用），null 表示还没生成过 */
  draft: import('../../domain/generator/types.ts').GenerationDraft | null;
  /** 生成来源的说明（「离线知识表」/「大模型 xxx」），供界面回显 */
  source: string;
  /** 上一条错误（生成失败时显示） */
  error: string | null;
}

export function createGenerationStore(): Store<GenerationState> {
  return new Store<GenerationState>({ running: false, draft: null, source: '', error: null }, 'generation');
}

export type GenerationStore = Store<GenerationState>;

// ── 语言指令 Store（PPT 第 3 页「03 编辑」的界面状态）────────────

export interface LanguageState {
  /** 上一次解析出来的指令（预览用），null 表示还没解析过 */
  parsed: import('../../domain/language/instructions.ts').ParseResult | null;
  /** 上一次反馈归因的结果 */
  feedback: import('../../domain/language/feedback.ts').FeedbackResult | null;
  /** 上一次执行结果的逐条说明 */
  outcomes: Array<{ ok: boolean; message: string }>;
  /** 反馈通道的执行结果。**与指令通道分开存**，否则作者点了「按这个调一下」，
   * 结果会出现在上方「用一句话改」那一段里——离他刚点的按钮隔着一个输入框，
   * 看着像没反应。 */
  feedbackOutcomes: Array<{ ok: boolean; message: string }>;
}

export function createLanguageStore(): Store<LanguageState> {
  return new Store<LanguageState>(
    { parsed: null, feedback: null, outcomes: [], feedbackOutcomes: [] },
    'language',
  );
}

export type LanguageStore = Store<LanguageState>;

// ── 设置 Store（LLM 连接设置；key 只存本地，不进仓库）───────────

export interface SettingsState {
  llm: import('../llm/client.ts').LlmSettings;
  /** 代理探活结果 */
  proxyReachable: boolean | null;
  proxyHasKey: boolean;
  proxyNote: string;
}

export function createSettingsStore(): Store<SettingsState> {
  return new Store<SettingsState>(
    {
      llm: {
        endpoint: '/api/llm',
        model: 'deepseek-chat',
        apiKey: '',
        temperature: 0.4,
        timeoutMs: 60000,
      },
      proxyReachable: null,
      proxyHasKey: false,
      proxyNote: '尚未探活',
    },
    'settings',
  );
}

export type SettingsStore = Store<SettingsState>;

// ── 汇总：一个对象把全部 Store 交给上层 ────────────────────────

export interface AppStores {
  storyboard: StoryboardStore;
  selection: SelectionStore;
  model: ModelStore;
  scene: SceneStore;
  demo: DemoStore;
  playback: PlaybackStore;
  camera: CameraStore;
  generation: GenerationStore;
  language: LanguageStore;
  settings: SettingsStore;
}

export function createAppStores(): AppStores {
  return {
    storyboard: createStoryboardStore(),
    selection: createSelectionStore(),
    model: createModelStore(),
    scene: createSceneStore(),
    demo: createDemoStore(),
    playback: createPlaybackStore(),
    camera: createCameraStore(),
    generation: createGenerationStore(),
    language: createLanguageStore(),
    settings: createSettingsStore(),
  };
}

/** 统计各求解状态的步骤数，供 UI 的徽章显示。 */
export function countBySolve(storyboard: Storyboard): Record<SolveState, number> {
  const out: Record<SolveState, number> = { none: 0, solved: 0, stale: 0, failed: 0 };
  for (const step of storyboard.steps) out[step.solve] += 1;
  return out;
}

/** 取出当前激活的步骤对象。 */
export function activeStep(state: StoryboardState): StoryboardStep | null {
  if (!state.activeStepId) return null;
  return state.storyboard.steps.find((s) => s.id === state.activeStepId) ?? null;
}
