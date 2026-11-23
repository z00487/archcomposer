/**
 * L3 领域层 · 创作者反馈驱动的局部调整（开题报告 §3.6）
 *
 * **开题报告原文**：「系统根据反馈识别需要修改的是内容、目标构件、视点还是视觉效果，
 * 只对对应部分进行调整，而不是重新生成整个讲解流程。」
 *
 * 这一层做的就是**归因**：拿到一句自然语言反馈，判断它说的是四类里的哪一类。
 * 它**不做修改**——修改由 L4 命令层执行。这样「判断错了吗」与「执行对了吗」
 * 是两个可以分开测的问题。
 *
 * **四类归因的原因**（为什么是这四类）：它们恰好是 `StoryboardStep` 里四个可以
 * 独立改动的部分（`narration` / `target` / `camera` / `effects`），也就是
 * 「局部调整」的四个天然粒度。改其中任何一个都不需要动其它三个——这正是
 * 开题报告 §3.6 想要的「只对对应部分调整」。
 */
import type { EditCommand } from './instructions.ts';
import { EditCommandKind } from './instructions.ts';
import { matchKinds, matchLocators, resolveComponents, extractDurationMs, extractMotionDegrees } from './instructions.ts';
import { extractOrdinal } from './chinese.ts';
import { INTENT_LABELS } from '../types/intent.ts';
import type { IntentKind } from '../types/intent.ts';
import type { SceneSummary } from '../types/solver.ts';
import type { Storyboard, StoryboardStep } from '../types/storyboard.ts';

/** 低于此置信度的归因不执行，界面提示作者换一种说法。 */
export const MIN_FEEDBACK_CONFIDENCE = 0.4;

export const FeedbackAspect = {
  /** 讲解内容：旁白、标题 */
  Content: 'content',
  /** 目标构件：讲错了东西、换成别个 */
  Target: 'target',
  /** 视点：看不清、角度不对 */
  Viewpoint: 'viewpoint',
  /** 视觉效果：高亮/透明度/显隐 */
  Effects: 'effects',
  /** 节奏：太快太慢、时长 */
  Pacing: 'pacing',
} as const;
export type FeedbackAspect = (typeof FeedbackAspect)[keyof typeof FeedbackAspect];

export const ASPECT_LABELS: Record<FeedbackAspect, string> = {
  content: '讲解内容',
  target: '目标构件',
  viewpoint: '观察视点',
  effects: '视觉效果',
  pacing: '节奏与时长',
};

export interface FeedbackDiagnosis {
  aspect: FeedbackAspect;
  /** 1 起的步骤序号；null 表示「当前步骤」 */
  stepIndex: number | null;
  /** 归因依据（哪个词把人引到这一类） */
  evidence: string[];
  confidence: number;
  /** 人类可读的归因理由 */
  rationale: string;
  /**
   * 建议的修改动作。**可能是空的**——例如「这个视角看不清」归因到「视点」，
   * 但作者没说是哪个角度，此时正确的做法不是瞎猜一个机位，而是**重新求解**
   * （用同一个意图再解一次，让求解器换一个候选）。因此这里给出的是
   * 「重新求解」这个动作，而不是一个具体的坐标。
   */
  suggested: EditCommand | null;
}

export interface FeedbackResult {
  diagnoses: FeedbackDiagnosis[];
  recognized: boolean;
  evidence: string[];
}

// ── 归因词表 ───────────────────────────────────────────────────
//
// **为什么每条词都带权重而不是平权**：一句话里常同时出现多个信号词
// （「看不清斗拱」既有「不清」也有构件名），需要按可信度排序。
// 权重来自一个朴素判断：直接说出部件名（「容器」类词）比评价性词汇更可靠。

const VIEWPOINT_WORDS: Array<[RegExp, number, string]> = [
  [/看不清|看不到|看不见|看不着/, 0.9, '「看不清」——典型的视点问题'],
  [/视角|角度|机位|镜头位/, 0.8, '直接提到「视角/角度」'],
  [/太近|太远|离得太远|怼|贴近/, 0.75, '提到距离不合适'],
  [/正对|侧着|斜着|从上面|从下面|俯视|仰视/, 0.7, '提到观察方向'],
  [/挡住|遮挡|被遮/, 0.65, '提到遮挡（既可归因视点、也可归因视觉效果）'],
];

const EFFECTS_WORDS: Array<[RegExp, number, string]> = [
  [/高亮|点亮|标出来|突出显示/, 0.85, '提到高亮'],
  [/透明|半透明|虚化|淡一点/, 0.85, '提到透明度'],
  [/隐藏|藏起来|不要显示|不显示/, 0.85, '提到显隐'],
  // 「保留」是**否定式**的视觉效果要求（别把它藏了 / 别把它调透明了），
  // 也是开题报告 §3.6 的原话「柱子应该一直保留」。缺了它这句话会归因不到任何一类。
  [/保留|留着|一直显示|保持可见|当作参照|作为参照/, 0.85, '要求某些构件保持可见（显隐类）'],
  [/颜色|太暗|太亮|发黑/, 0.7, '提到材质观感'],
];

const CONTENT_WORDS: Array<[RegExp, number, string]> = [
  [/讲得太|说得太|讲得|表述|说法|措辞|文字|旁白|解说词|讲解词/, 0.8, '提到讲解文字的表述'],
  [/复杂|啰嗦|太长|太短|简略|详细|生硬|不通顺/, 0.75, '对讲解内容的评价'],
  [/换个说法|重写|改写|措辞/, 0.8, '要求改写措辞'],
];

const TARGET_WORDS: Array<[RegExp, number, string]> = [
  [/讲错|搞错|不是这个|换成|改成讲|应该讲|要讲的是|重点应该是/, 0.8, '指出讲错了对象'],
  [/这个构件|那个构件|指的是/, 0.7, '指出构件指代有误'],
];

const PACING_WORDS: Array<[RegExp, number, string]> = [
  [/太快|太慢|节奏|切换太快|转得太快|别这么快/, 0.85, '提到节奏/切换速度'],
  [/停留|停久|停短|时长|持续/, 0.8, '提到时长'],
  // 「停 8 秒」这种说法里没有「停留」二字，只有一个「停」加数字——
  // 这是作者最自然的说法之一，光靠上面的词表会漏掉
  [/停\s*[0-9０-９一二两三四五六七八九十]/, 0.8, '提到具体停留秒数'],
];

const MOTION_WORDS: Array<[RegExp, number, string]> = [
  [/绕一圈|环绕|转一圈|旋转/, 0.8, '提到运镜'],
];

/**
 * 归因主入口。
 *
 * **为什么一次可以给出多条归因**：「这个视角看不清斗拱，而且柱子别隐藏」是两件事，
 * 分属视点与视觉效果。把两条都给出、由界面分别呈现，比强行归成一类更诚实。
 */
export function diagnoseFeedback(
  text: string,
  context: {
    scene: SceneSummary | null;
    storyboard: Storyboard;
    activeStepId: string | null;
  },
): FeedbackResult {
  const raw = text.trim();
  if (!raw) return { diagnoses: [], recognized: false, evidence: [] };

  const clauses = raw
    .split(/[，。；！？,.;!?]+|并且|然后|同时|而且/)
    .map((c) => c.trim())
    .filter(Boolean);

  const diagnoses: FeedbackDiagnosis[] = [];
  const allEvidence: string[] = [];

  for (const clause of clauses) {
    const d = diagnoseClause(clause, context);
    if (d) {
      diagnoses.push(d);
      allEvidence.push(...d.evidence);
    }
  }

  const recognized = diagnoses.some((d) => d.confidence >= MIN_FEEDBACK_CONFIDENCE);
  return {
    diagnoses: recognized ? diagnoses.filter((d) => d.confidence >= MIN_FEEDBACK_CONFIDENCE) : [],
    recognized,
    evidence: allEvidence,
  };
}

function diagnoseClause(
  clause: string,
  context: { scene: SceneSummary | null; storyboard: Storyboard; activeStepId: string | null },
): FeedbackDiagnosis | null {
  const ordinal = extractOrdinal(clause);
  const stepIndex = ordinal ?? activeOrdinal(context);
  const evidence: string[] = [];

  // 收集所有命中的信号，按权重排序后取胜出的一类
  const hits: Array<{ aspect: FeedbackAspect; weight: number; why: string }> = [];
  const collect = (aspect: FeedbackAspect, table: Array<[RegExp, number, string]>): void => {
    for (const [re, weight, why] of table) {
      if (re.test(clause)) hits.push({ aspect, weight, why });
    }
  };
  collect(FeedbackAspect.Viewpoint, VIEWPOINT_WORDS);
  collect(FeedbackAspect.Effects, EFFECTS_WORDS);
  collect(FeedbackAspect.Content, CONTENT_WORDS);
  collect(FeedbackAspect.Target, TARGET_WORDS);
  collect(FeedbackAspect.Pacing, PACING_WORDS);
  // 运镜也算「节奏」类：作者说「让这一步绕一圈」时想改的是这一步的运动，
  // 而运镜确实会改变这一步的观感节奏
  collect(FeedbackAspect.Pacing, MOTION_WORDS);

  if (hits.length === 0) return null;

  hits.sort((a, b) => b.weight - a.weight);
  const winner = hits[0];
  for (const h of hits) evidence.push(h.why);

  const step = stepAt(context.storyboard, context.activeStepId, stepIndex);

  switch (winner.aspect) {
    case FeedbackAspect.Viewpoint: {
      // 「看不清」时**不猜机位**，而是让求解器按同一个意图重解一次——
      // 这正是「只改视点、不动内容与目标」的最小动作
      return {
        aspect: FeedbackAspect.Viewpoint,
        stepIndex,
        evidence,
        confidence: winner.weight,
        rationale: `判为「视点」问题：${winner.why}。只重新求解机位，内容、目标与视觉效果都不动。`,
        suggested: {
          kind: EditCommandKind.ReSolve,
          stepIndex,
          componentIds: [],
          confidence: winner.weight,
          rationale: '按原意图重新求解机位',
        },
      };
    }

    case FeedbackAspect.Effects: {
      const kinds = matchKinds(clause);
      const locators = matchLocators(clause);
      const ids = resolveComponents(kinds, locators, context.scene);
      const keep = /保留|不要隐藏|别隐藏|留着/.test(clause);
      const hide = /隐藏|藏起来|不要显示|不显示/.test(clause);
      const hl = /高亮|点亮|标出来/.test(clause);
      const kind = keep
        ? EditCommandKind.KeepComponents
        : hide
          ? EditCommandKind.HideComponents
          : hl
            ? EditCommandKind.HighlightComponents
            : EditCommandKind.KeepComponents;
      return {
        aspect: FeedbackAspect.Effects,
        stepIndex,
        evidence,
        confidence: ids.length > 0 ? winner.weight : Math.min(winner.weight, 0.45),
        rationale: ids.length > 0
          ? `判为「视觉效果」问题：${winner.why}。只改这一类的视觉状态，内容与目标不动。`
          : `判为「视觉效果」问题，但没识别出是哪些构件——请指明构件名。`,
        suggested: ids.length > 0
          ? {
              kind,
              stepIndex,
              componentIds: ids,
              confidence: winner.weight,
              rationale: `只调整这些构件的视觉状态`,
            }
          : null,
      };
    }

    case FeedbackAspect.Content: {
      return {
        aspect: FeedbackAspect.Content,
        stepIndex,
        evidence,
        confidence: winner.weight,
        rationale: `判为「讲解内容」问题：${winner.why}。只改旁白/标题，目标、机位与视觉效果都不动。`,
        suggested: null, // 改写文字需要作者的原文，系统不代笔——这正是 NFR 里「不擅自改内容」的意思
      };
    }

    case FeedbackAspect.Target: {
      const kinds = matchKinds(clause);
      const locators = matchLocators(clause);
      const ids = resolveComponents(kinds, locators, context.scene);
      return {
        aspect: FeedbackAspect.Target,
        stepIndex,
        evidence,
        confidence: ids.length > 0 ? winner.weight : Math.min(winner.weight, 0.45),
        rationale: ids.length > 0
          ? `判为「目标构件」问题：${winner.why}。换成识别出的新目标并按原意图重解。`
          : `判为「目标构件」问题：${winner.why}。但没识别出新目标，请指明构件名。`,
        suggested: ids.length > 0
          ? {
              kind: EditCommandKind.Retarget,
              stepIndex,
              componentIds: [ids[0]],
              confidence: winner.weight,
              rationale: '换目标并按原意图重解',
            }
          : null,
      };
    }

    case FeedbackAspect.Pacing: {
      const durationMs = extractDurationMs(clause);
      const degrees = extractMotionDegrees(clause);
      const wantsMotion = MOTION_WORDS.some(([re]) => re.test(clause));
      if (wantsMotion && degrees !== null) {
        return {
          aspect: FeedbackAspect.Pacing,
          stepIndex,
          evidence,
          confidence: winner.weight,
          rationale: `判为「节奏」问题：${winner.why}。给这一步加上环绕运镜 ${degrees}°。`,
          suggested: {
            kind: EditCommandKind.SetMotion,
            stepIndex,
            componentIds: [],
            payload: { degrees },
            confidence: winner.weight,
            rationale: `环绕 ${degrees}°`,
          },
        };
      }
      if (durationMs !== null) {
        return {
          aspect: FeedbackAspect.Pacing,
          stepIndex,
          evidence,
          confidence: winner.weight,
          rationale: `判为「节奏」问题：${winner.why}。只改时长，其余都不动。`,
          suggested: {
            kind: EditCommandKind.SetDuration,
            stepIndex,
            componentIds: [],
            payload: { durationMs },
            confidence: winner.weight,
            rationale: `时长改为 ${(durationMs / 1000).toFixed(1)} 秒`,
          },
        };
      }
      // 说了「太快」但没给具体时长 → 给一个保守的放慢建议（+60%），并说明这是系统提的
      const slower = /太快|太短|切换太快/.test(clause);
      if (step) {
        const suggestedMs = Math.round(step.durationMs * (slower ? 1.6 : 0.65));
        return {
          aspect: FeedbackAspect.Pacing,
          stepIndex,
          evidence,
          confidence: Math.min(winner.weight, 0.65),
          rationale: `判为「节奏」问题（${winner.why}），但没给出具体时长。建议把这一步从 ${(step.durationMs / 1000).toFixed(1)} 秒调到 ${(suggestedMs / 1000).toFixed(1)} 秒——这只是建议，请确认。`,
          suggested: {
            kind: EditCommandKind.SetDuration,
            stepIndex,
            componentIds: [],
            payload: { durationMs: suggestedMs },
            confidence: 0.55,
            rationale: `时长改为 ${(suggestedMs / 1000).toFixed(1)} 秒（系统建议）`,
          },
        };
      }
      return {
        aspect: FeedbackAspect.Pacing,
        stepIndex,
        evidence,
        confidence: Math.min(winner.weight, 0.5),
        rationale: `判为「节奏」问题，但没有可调整的步骤或具体数值。`,
        suggested: null,
      };
    }

    default:
      return null;
  }
}

function activeOrdinal(context: { storyboard: Storyboard; activeStepId: string | null }): number | null {
  if (!context.activeStepId) return null;
  const index = context.storyboard.steps.findIndex((s) => s.id === context.activeStepId);
  return index >= 0 ? index + 1 : null;
}

function stepAt(storyboard: Storyboard, activeStepId: string | null, ordinal: number | null): StoryboardStep | null {
  if (ordinal !== null) return storyboard.steps[ordinal - 1] ?? null;
  if (!activeStepId) return null;
  return storyboard.steps.find((s) => s.id === activeStepId) ?? null;
}

/** 供界面回显：把归因结果写成一句话。 */
export function describeDiagnosis(d: FeedbackDiagnosis): string {
  const where = d.stepIndex !== null ? `第 ${d.stepIndex} 步` : '当前步骤';
  return `${where} · ${ASPECT_LABELS[d.aspect]}：${d.rationale}`;
}

/** 意图类型的中文名（界面回显用，避免各处硬编码）。 */
export function intentLabel(kind: IntentKind): string {
  return INTENT_LABELS[kind];
}
