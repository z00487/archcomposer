/**
 * L3 领域层 · M7 规则化意图推断
 *
 * 依据：《项目概要设计文档》§4.2.1、§6.1。
 *
 * **第一版的推断策略是「规则 + 状态差异」，刻意不训练模型。**
 * 理由（概要设计 §4.2.1）：任务一 §8 的 R2 已把「推断置信度低」列为高风险，
 * 而 FR-14 的设计本身就是「给候选、让人确认」，因此**第一版的目标是
 * 「可信地给出候选」，不是「猜得准」**。
 *
 * 规则化还有一个额外好处：**规则就是可解释性**。用户能看到「为什么系统认为
 * 你想强调这个」——每一条规则都产出一句人类可读的 `rationale`。
 */
import type { ComponentId } from '../types/component.ts';
import type {
  IntentPredicate,
  IntentPrediction,
  IntentSignal,
  VisualIntent,
} from '../types/intent.ts';
import {
  INTENT_DEFAULTS,
  IntentKind,
  IntentSource,
  INTENT_LABELS,
  defaultPredicatesFor,
  predicate,
  relationDistanceRange,
} from '../types/intent.ts';
import type { DemoOutcome } from '../types/storyboard.ts';
import type { SceneComponent, SceneSummary, TargetRef } from '../types/solver.ts';
import { targetIds } from '../types/solver.ts';
import { makeId } from '../../core/id.ts';
import { aabbCenter, v3distance } from '../../core/math.ts';

/** 低于此置信度的候选不返回（§6.1 的失败处理：宁可不猜）。 */
export const MIN_CONFIDENCE = 0.35;

/**
 * 信号 3 的判定阈值：相机与目标的距离变化比。
 *
 * 「拉近 = 强调，后退 = 全局」——但这个「拉近」必须相对于那个构件的尺度来算，
 * 不能看绝对距离（讲一根椽和讲整个屋顶，合适的距离差一个数量级）。
 */
export const APPROACH_RATIO = 0.82;
export const RECEDE_RATIO = 1.22;

/** 抽取信号 1：选中与操作焦点。 */
export function signalSelection(outcome: DemoOutcome): IntentSignal | null {
  if (outcome.touchedIds.length === 0) return null;
  const detail =
    outcome.touchedIds.length === 1
      ? `示范中只操作了 1 个构件（${outcome.touchedIds[0]}），判为讲解焦点`
      : `示范中操作了 ${outcome.touchedIds.length} 个构件，以最后选中的那个为焦点`;
  return { kind: 'selection', detail, weight: 0.7 };
}

/** 抽取信号 2：透明度与显隐变化。 */
export function signalOpacityAndVisibility(outcome: DemoOutcome): IntentSignal[] {
  const signals: IntentSignal[] = [];
  const transparentIds = Object.keys(outcome.opacities);
  if (transparentIds.length > 0) {
    const most = transparentIds.reduce((a, b) =>
      outcome.opacities[a] <= outcome.opacities[b] ? a : b,
    );
    signals.push({
      kind: 'opacity',
      detail: `构件「${most}」被调至 ${Math.round(outcome.opacities[most] * 100)}% 透明度——这是「留作上下文」的典型做法`,
      weight: 0.6,
    });
  }
  if (outcome.hidden.length > 0) {
    signals.push({
      kind: 'visibility',
      detail: `有 ${outcome.hidden.length} 个构件被隐藏——这是「排除遮挡」的典型做法`,
      weight: 0.65,
    });
  }
  return signals;
}

/**
 * 抽取信号 3：相机相对目标的位姿变化。
 *
 * 分三种情形（对应 §4.2.1 的信号 3）：
 *  - 拉近（距离变小）→ 强调强度提升；
 *  - 后退（距离变大）→ 想要全局视野；
 *  - 绕行（方位角大幅变化）→ 想看关系。
 */
export function signalCamera(outcome: DemoOutcome, scene: SceneSummary): IntentSignal[] {
  const signals: IntentSignal[] = [];
  const track = outcome.cameraTrack;
  if (track.length < 2) return signals;

  const first = track[0];
  const last = track[track.length - 1];
  const focusId = outcome.selectedId;
  const focus = focusId ? scene.components.find((c) => c.id === focusId) : null;
  if (!focus) return signals;

  const center = aabbCenter({ min: focus.aabbMin, max: focus.aabbMax });
  const scale = componentScale(focus);
  const d0 = v3distance(first.position, center) / scale;
  const d1 = v3distance(last.position, center) / scale;
  const ratio = d1 / Math.max(d0, 1e-6);

  if (ratio <= APPROACH_RATIO) {
    signals.push({
      kind: 'camera',
      detail: `相机从 ${d0.toFixed(1)} 倍构件尺度拉近到 ${d1.toFixed(1)} 倍，是「强调」的典型动作`,
      weight: 0.75,
    });
  } else if (ratio >= RECEDE_RATIO) {
    signals.push({
      kind: 'camera',
      detail: `相机从 ${d0.toFixed(1)} 倍构件尺度后退到 ${d1.toFixed(1)} 倍，是「要全局视野」的典型动作`,
      weight: 0.7,
    });
  }

  // 方位角变化 → 绕行
  const a0 = Math.atan2(first.position[0] - center[0], first.position[2] - center[2]);
  const a1 = Math.atan2(last.position[0] - center[0], last.position[2] - center[2]);
  let delta = Math.abs(a1 - a0) % (Math.PI * 2);
  if (delta > Math.PI) delta = Math.PI * 2 - delta;
  if (delta > 0.6) {
    signals.push({
      kind: 'camera',
      detail: `相机绕目标转了约 ${Math.round((delta * 180) / Math.PI)}°，是在寻找能同时看到两端的角度`,
      weight: 0.6,
    });
  }

  // 俯角
  const elevation = (pose: typeof last) => {
    const rel = [pose.position[0] - center[0], pose.position[1] - center[1], pose.position[2] - center[2]];
    const dist = Math.hypot(rel[0], rel[1], rel[2]);
    return dist < 1e-6 ? 0 : rel[1] / dist;
  };
  if (elevation(last) > INTENT_DEFAULTS.overviewElevation) {
    signals.push({
      kind: 'camera',
      detail: `结束机位在目标上方（高度比 ${elevation(last).toFixed(2)}），偏向俯瞰`,
      weight: 0.55,
    });
  }

  return signals;
}

/** 抽取信号 4：自然语言中的动词与关系词。 */
export function signalLanguage(text: string): IntentSignal[] {
  const signals: IntentSignal[] = [];
  if (!text.trim()) return signals;
  const relationWords = ['承托', '搭接', '连接', '关系', '之间', '与', '和', '支撑', '受力'];
  const emphasisWords = ['注意', '重点', '这里', '看这个', '强调', '关键是'];
  const overviewWords = ['整体', '全局', '俯瞰', '概览', '总体', '鸟瞰'];
  const occlusionWords = ['挡住', '遮挡', '看不见', '后面'];

  if (relationWords.some((w) => text.includes(w))) {
    signals.push({ kind: 'language', detail: '旁白里出现了关系词，倾向「揭示构件关系」', weight: 0.8 });
  }
  if (emphasisWords.some((w) => text.includes(w))) {
    signals.push({ kind: 'language', detail: '旁白里出现了提示词，倾向「强调目标」', weight: 0.7 });
  }
  if (overviewWords.some((w) => text.includes(w))) {
    signals.push({ kind: 'language', detail: '旁白里出现了整体性词汇，倾向「总体俯瞰」', weight: 0.75 });
  }
  if (occlusionWords.some((w) => text.includes(w))) {
    signals.push({ kind: 'language', detail: '旁白提到遮挡，倾向「减少遮挡」', weight: 0.7 });
  }
  return signals;
}

// ── 信号 → 候选意图 ────────────────────────────────────────────

/**
 * 把信号汇总成「每类意图的得分」，再翻译成候选。
 *
 * **为什么先算分再翻译，而不是逐条规则直接产出候选**：因为多条规则可能指向
 * 同一类意图（如「拉近相机」+「旁白说注意」都指向 `EMPHASIZE`），需要合并且
 * 不重复。分桶再翻译天然做到了这件事。
 */
function scoreByKind(signals: IntentSignal[]): Map<IntentKind, { score: number; signals: IntentSignal[] }> {
  const buckets = new Map<IntentKind, { score: number; signals: IntentSignal[] }>();
  const add = (kind: IntentKind, signal: IntentSignal, weight: number): void => {
    const bucket = buckets.get(kind) ?? { score: 0, signals: [] };
    bucket.score += signal.weight * weight;
    bucket.signals.push(signal);
    buckets.set(kind, bucket);
  };

  for (const signal of signals) {
    switch (signal.kind) {
      case 'selection':
        add(IntentKind.Emphasize, signal, 1.0);
        break;
      case 'opacity':
        // 调透明：既可解读为「留作上下文」，也可解读为「减少遮挡」——两者都给出，
        // 让用户选。**这正是 FR-14「给候选、让人确认」的价值所在。**
        add(IntentKind.KeepContext, signal, 0.9);
        add(IntentKind.ReduceOcclusion, signal, 0.6);
        break;
      case 'visibility':
        add(IntentKind.ReduceOcclusion, signal, 1.0);
        break;
      case 'camera':
        if (signal.detail.includes('拉近')) add(IntentKind.Emphasize, signal, 1.0);
        else if (signal.detail.includes('后退')) add(IntentKind.ShowOverview, signal, 1.0);
        else if (signal.detail.includes('俯')) add(IntentKind.ShowOverview, signal, 0.9);
        else add(IntentKind.RevealRelation, signal, 0.8);
        break;
      case 'language':
        if (signal.detail.includes('关系')) add(IntentKind.RevealRelation, signal, 1.2);
        else if (signal.detail.includes('强调')) add(IntentKind.Emphasize, signal, 1.1);
        else if (signal.detail.includes('整体')) add(IntentKind.ShowOverview, signal, 1.1);
        else if (signal.detail.includes('遮挡')) add(IntentKind.ReduceOcclusion, signal, 1.1);
        break;
    }
  }

  return buckets;
}

/** 把得分归一化成 0~1 的置信度。 */
function confidenceOf(score: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  // 用相对最高分的比例，再做一个保守的缩放——绝对分高的情形也不给满分，
  // 因为这是规则推断，不该表现得比用户确认更自信
  return Math.min(0.92, (score / maxScore) * 0.85);
}

/**
 * 主入口：从示范结果推断候选意图（§6.1 流程一的核心）。
 *
 * `language` 是可选的自然语言通道（FR-13，D4 待定）。若为空则只用前三条信号。
 *
 * **返回值中 `recognized: false` 是一个正常结果，不是失败。** 它明确告诉 UI
 * 「不要替我猜」，UI 应当引导用户手动选择意图类型（`setManualIntent`）。
 * 这比返回一个低置信度的瞎猜更符合 FR-14 的精神。
 */
export function analyzeDemo(
  outcome: DemoOutcome,
  scene: SceneSummary,
  language = '',
): { predictions: IntentPrediction[]; recognized: boolean; signals: IntentSignal[] } {
  const signals: IntentSignal[] = [];
  const selectionSignal = signalSelection(outcome);
  if (selectionSignal) signals.push(selectionSignal);
  signals.push(...signalOpacityAndVisibility(outcome));
  signals.push(...signalCamera(outcome, scene));
  signals.push(...signalLanguage(language));

  if (signals.length === 0) {
    return { predictions: [], recognized: false, signals };
  }

  const buckets = scoreByKind(signals);
  const maxScore = Math.max(...[...buckets.values()].map((b) => b.score), 0);

  const target = buildTarget(outcome, scene);
  const predictions: IntentPrediction[] = [];

  for (const [kind, bucket] of buckets) {
    const confidence = confidenceOf(bucket.score, maxScore);
    if (confidence < MIN_CONFIDENCE) continue;
    predictions.push({
      intent: buildIntent(kind, confidence, bucket.signals, outcome, scene, target),
      signals: bucket.signals,
    });
  }

  // 按置信度降序。置信度相同则按意图类型的固定顺序，保证输出稳定（可复现）
  predictions.sort((a, b) => {
    const d = b.intent.provenance.confidence - a.intent.provenance.confidence;
    if (Math.abs(d) > 1e-9) return d;
    return a.intent.kind < b.intent.kind ? -1 : a.intent.kind > b.intent.kind ? 1 : 0;
  });

  return { predictions, recognized: predictions.length > 0, signals };
}

/** 构造目标引用。两个构件同时被操作时优先判为关系型目标。 */
export function buildTarget(outcome: DemoOutcome, scene: SceneSummary): TargetRef | null {
  const ids = outcome.touchedIds.filter((id) => scene.components.some((c) => c.id === id));
  if (ids.length === 0) {
    if (!outcome.selectedId) return null;
    const component = scene.components.find((c) => c.id === outcome.selectedId);
    return component ? { form: 'single', component: { id: component.id, semantics: component.semantics } } : null;
  }
  if (ids.length === 1) {
    const component = scene.components.find((c) => c.id === ids[0])!;
    return { form: 'single', component: { id: component.id, semantics: component.semantics } };
  }
  const from = scene.components.find((c) => c.id === ids[0])!;
  const to = scene.components.find((c) => c.id === ids[ids.length - 1])!;
  return {
    form: 'relation',
    from: { id: from.id, semantics: from.semantics },
    to: { id: to.id, semantics: to.semantics },
    relation: 'stacked',
  };
}

/**
 * 生成一个候选意图。
 *
 * **阈值从示范里反推**（§5.5 的说明）：这是把「作者的偏好」编码进意图的关键做法。
 * 例如作者把相机拉近到目标占比 0.32，就把 `screenCoverage` 的阈值设在 0.32 的
 * 一个保守折扣上（0.8 倍），而不是用事先设好的魔法数字。
 */
export function buildIntent(
  kind: IntentKind,
  confidence: number,
  signals: IntentSignal[],
  outcome: DemoOutcome,
  scene: SceneSummary,
  target: TargetRef | null,
): VisualIntent {
  const targetIdList = target ? targetIds(target) : [];
  const predicates = derivePredicates(kind, targetIdList, outcome, scene, target);
  const rationale = buildRationale(kind, signals);

  return {
    id: makeId('intent'),
    kind,
    predicates,
    provenance: {
      source: IntentSource.Demo,
      confidence: Number(confidence.toFixed(3)),
      rationale,
      // ★ 推断出来的意图**默认未经确认**。用户在对话框里点「应用」后
      //   才会由 `acceptPrediction` 置为 true（FR-14 的留痕）
      confirmedByUser: false,
    },
  };
}

/**
 * 从示范的实测值反推谓词阈值。
 *
 * 这条逻辑是「意图自动带上作者偏好」的实现。若示范里没有足够的相机信息，
 * 就退回 §5.5 的默认阈值——**退回是有意的，不是错误**。
 */
export function derivePredicates(
  kind: IntentKind,
  targetIdList: ComponentId[],
  outcome: DemoOutcome,
  scene: SceneSummary,
  target: TargetRef | null,
): IntentPredicate[] {
  const subjects = target?.form === 'relation' ? targetIdList : [];
  const base = defaultPredicatesFor(kind, subjects);

  switch (kind) {
    case IntentKind.Emphasize: {
      // 用示范结束时相机相对目标的距离，粗略反推画面占比的量级。
      // 简化模型：占比 ≈ 构件尺度 / 距离，再乘一个经验系数。
      const focus = outcome.selectedId ? scene.components.find((c) => c.id === outcome.selectedId) : null;
      const track = outcome.cameraTrack;
      if (!focus || track.length === 0) return base;
      const last = track[track.length - 1];
      const center = aabbCenter({ min: focus.aabbMin, max: focus.aabbMax });
      const scale = componentScale(focus);
      const distance = v3distance(last.position, center);
      const estimated = Math.min(0.95, (scale / Math.max(distance, 0.1)) * 0.55);
      // 阈值取实测值的一个保守折扣：0.8 倍。做法来自 §5.5 的说明。
      const threshold = Math.max(0.05, Number((estimated * 0.8).toFixed(3)));
      return [
        predicate.coverageAtLeast(threshold, subjects),
        predicate.unoccluded(subjects),
      ];
    }

    case IntentKind.RevealRelation: {
      if (target?.form !== 'relation') return base;
      const from = scene.components.find((c) => c.id === target.from.id);
      const to = scene.components.find((c) => c.id === target.to.id);
      if (!from || !to) return base;
      const gap = v3distance(
        aabbCenter({ min: from.aabbMin, max: from.aabbMax }),
        aabbCenter({ min: to.aabbMin, max: to.aabbMax }),
      );
      // 世界间隙越大，画面距离区间的下限越宽（两个东西离得远，同框时本来就分得开）
      const range = relationDistanceRange(gap);
      return [
        predicate.coVisible([target.from.id, target.to.id]),
        predicate.screenDistanceIn(range, [target.from.id, target.to.id]),
        predicate.unoccluded([target.from.id, target.to.id]),
      ];
    }

    case IntentKind.KeepContext: {
      // 上下文构件 = 被调透明的那些（正是作者的「这是背景」声明）
      const contextIds = Object.keys(outcome.opacities);
      if (contextIds.length === 0) return base;
      return [
        predicate.contextVisibleRatioAtLeast(INTENT_DEFAULTS.contextVisibleRatio, contextIds),
        predicate.unoccluded(subjects),
      ];
    }

    case IntentKind.ShowOverview:
    case IntentKind.ReduceOcclusion:
    default:
      return base;
  }
}

/** 生成人类可读的推断理由——用户要能看到「系统为什么这么认为」。 */
function buildRationale(kind: IntentKind, signals: IntentSignal[]): string {
  const detail = signals.map((s) => s.detail).join('；');
  return `判为「${INTENT_LABELS[kind]}」：${detail}`;
}

/** 构件尺度（最长边），与保真度模块里的定义保持一致。 */
function componentScale(component: SceneComponent): number {
  return Math.max(
    component.aabbMax[0] - component.aabbMin[0],
    component.aabbMax[1] - component.aabbMin[1],
    component.aabbMax[2] - component.aabbMin[2],
    0.05,
  );
}

