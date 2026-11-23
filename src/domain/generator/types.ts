/**
 * L3 领域层 · 生成器的数据契约
 *
 * 依据：《项目概要设计文档》的 M7 上游、开题报告 §3.2「面向讲解目标的完整解说草稿生成」、
 * 答辩 PPT 第 3 页的「01 生成」与第 5 页的流程第一跳。
 *
 * **这一组类型的意义：把「生成」与「求解」解耦。**
 *
 * 生成器只负责回答「**讲什么、按什么顺序、要什么意图**」，它**不负责**算机位。
 * 机位由既有的采样求解器（M8）按意图求解——那套机制已经过 204 项测试与重定向
 * 实测，不该被生成器绕过。因此生成的产物是一个 `GenerationDraft`（草稿），
 * 里面每个 `DraftStep` 只有「目标构件 + 意图 + 旁白 + 时长」，没有 `camera`。
 *
 * 这样切分带来三个直接好处：
 *  1. **生成结果可离线断言**：草稿是纯数据，测试里可以把「输入『讲屋顶和斗拱』
 *     应当产出哪几步」逐条断出来，不需要浏览器、不需要网络、不需要 API key；
 *  2. **LLM 与规则两条路可以互换**：它们产出同一种草稿，下游一行都不用改；
 *  3. **生成的那一步不会偷偷降低质量**：草稿里的机位由求解器按意图求得并有保真度
 *     可查，而不是「LLM 随口给一个坐标」。
 */
import type { ComponentId } from '../types/component.ts';
import type { IntentKind } from '../types/intent.ts';

/** 生成请求：作者给的那句话 + 当前可用构件。 */
export interface GenerationRequest {
  /** 作者的讲解目标，如「给第一次参观的游客做个 3 分钟讲解，重点介绍整体、屋顶和斗拱」 */
  goal: string;
  /** 观众是谁（可空）。影响旁白的措辞深浅，不影响选题。 */
  audience: string;
  /** 目标时长（毫秒）。空则由生成器按知识点数量估算。 */
  targetDurationMs: number | null;
  /** 当前模型里可以引用的构件（生成器不得引用此清单之外的 ID） */
  components: GenerationComponent[];
  /** 模型前缀，用于拼稳定 ID */
  modelPrefix: string;
}

/** 生成时可引用的构件（求解器的 `SceneComponent` 精简版，只留生成需要的字段）。 */
export interface GenerationComponent {
  id: ComponentId;
  kind: string;
  /** 部位定位，如 `e` / `w` / `c_front` / `se` */
  part: string;
  label: string;
}

/**
 * 草稿里的一步。**没有 `camera`——这是刻意的。**
 */
export interface DraftStep {
  title: string;
  narration: string;
  /** 目标构件（必须来自请求里的 components） */
  targetId: ComponentId;
  /** 关系型目标的第二端（可空）。有值时这一步是「揭示两端关系」 */
  partnerId?: ComponentId;
  intentKind: IntentKind;
  durationMs: number;
  /** 运镜角度（可空）。「全景环绕」这类镜头由生成器按知识点给出建议。 */
  motionDegrees?: number;
  /** 这一步为什么被选中（供界面回显与论文记录，如「目标里提到了『斗拱』」） */
  reason: string;
}

export interface GenerationDraft {
  title: string;
  steps: DraftStep[];
  /** 生成器的名字与版本，用于论文里区分「哪一版生成的」 */
  generator: string;
  /** 生成过程的说明（命中了哪些知识点、为什么是这个顺序、哪里降级了） */
  notes: string[];
  /**
   * 生成时的告警（**不阻断**，但必须让作者看到）。例如：
   * 「目标里提到的『檐椽』在模型里找不到对应构件，已跳过」。
   * 这条与 FR-19「不许静默降级」是同一个立场，只是发生在生成阶段。
   */
  warnings: string[];
}

/**
 * 生成器接口（对应约束 C-2 的「可替换」思想，与 `ViewSolver` 同构）。
 *
 * 两个实现：
 *  - `RuleStoryboardGenerator`（L3，离线、确定性、无依赖）；
 *  - `LlmStoryboardGenerator`（L3 组装 + L4 走本地代理转发）。
 *
 * 调用方（L4 命令层）不知道也不关心拿到的是哪一个。
 */
export interface StoryboardGenerator {
  readonly name: string;
  /** 是否需要联网/API key。UI 据此决定「生成」按钮的提示文案。 */
  readonly requiresNetwork: boolean;
  generate(request: GenerationRequest): Promise<GenerationDraft>;
}
