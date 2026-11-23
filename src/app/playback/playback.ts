/**
 * L4 应用层 · M12 分镜播放
 *
 * 依据：《项目概要设计文档》§4.1 的 M12、§6.3 流程三。
 *
 * **播放的三条纪律**（§6.3）：
 *  1. **播放不改数据。** 作者在播放中手动转相机不污染 `step.camera`。这是
 *     「播放」与「编辑」的边界，避免 E2 的编辑成本统计被污染。
 *  2. **遇到未求解/失效的步骤要暂停并提示**，不静默跳过——静默跳过会让作者
 *     以为「播过了」。
 *  3. 相机与透明度用补间，**隐藏与高亮瞬时切换**（渐变会让观感混乱）。
 *
 * **实现选择**：不引 `@tweenjs/tween.js`，用手写的插值循环。
 * 理由：需要的插值只有「相机位姿」与「透明度」两种，手写 30 行就够；
 * 而 tween.js 会引入一个额外的运行时依赖与它自己的时间管理（与
 * requestAnimationFrame 的双重驱动容易打架）。**这条取舍与任务二 §2.1
 * 的选型表不同，已记入任务三文档的偏差说明。**
 */
import type { PlaybackStore, CameraStore, StoryboardStore } from '../stores/stores.ts';
import type { EffectManager } from '../../runtime/effects/effects.ts';
import type { Viewport } from '../../runtime/scene/viewport.ts';
import type { StoryboardStep } from '../../domain/types/storyboard.ts';
import type { Pose } from '../../domain/types/geometry.ts';
import { clonePose, lerp, quatSlerp } from '../../core/math.ts';

export interface PlaybackDeps {
  playback: PlaybackStore;
  camera: CameraStore;
  storyboard: StoryboardStore;
  effects: EffectManager;
  viewport: Viewport;
}

/** 播放器的对外能力。 */
export interface PlaybackController {
  play(fromIndex?: number): void;
  pause(): void;
  stop(): void;
  /** 跳到某一步（编辑时的「预览这一步」） */
  previewStep(index: number): void;
  isPlaying(): boolean;
}

/**
 * 位姿插值。
 *
 * 位置线性、朝向用**球面插值**（`quatSlerp`）。用逐分量线性插值四元数在
 * 大幅度转场时会出现「转速忽快忽慢」的观感，而 slerp 是匀速的。
 */
function interpolatePose(a: Pose, b: Pose, t: number): Pose {
  return {
    position: [
      lerp(a.position[0], b.position[0], t),
      lerp(a.position[1], b.position[1], t),
      lerp(a.position[2], b.position[2], t),
    ],
    quaternion: quatSlerp(a.quaternion, b.quaternion, t),
    fovY: lerp(a.fovY, b.fovY, t),
  };
}

/**
 * 缓动函数。用 smootherstep 而不是线性：线性运动的相机启停过于生硬，
 * 而 smootherstep 的首尾导数为 0，观感接近专业分镜软件。
 */
function ease(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function createPlaybackController(deps: PlaybackDeps): PlaybackController {
  let rafId = 0;
  let cancelled = false;

  function cancelLoop(): void {
    cancelled = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function setBlocked(reason: string | null): void {
    deps.playback.set((s) => ({ ...s, blockedReason: reason }));
  }

  /**
   * 执行单个步骤：把相机与透明度补间到目标状态，然后瞬时切换隐藏/高亮。
   *
   * **返回一个 Promise**，让 `play` 能顺序等待。这里刻意不用 async 语法糖
   * 包整个流程，而是用「回调 + rAF」——因为要能在任意时刻 `cancelLoop()`
   * 打断，Promise 链的打断需要额外的信号传递。
   */
  function runStep(step: StoryboardStep, onDone: () => void): void {
    const from = deps.viewport.getPose();
    const to = step.camera;
    if (!to) {
      onDone();
      return;
    }

    // ★ 顺序很重要：**先**采样当前透明度，**再**施加特效。
    //   若反过来，采样到的就是「目标透明度」，补间会变成原地不动（看着像没生效）。
    const fromOpacity = new Map<string, number>();
    if (deps.effects.model) {
      for (const c of deps.effects.model.components) {
        fromOpacity.set(c.id, readOpacity(c.object));
      }
    }

    // 瞬时切换的部分：高亮与隐藏不做渐变（§6.3）
    deps.effects.apply({
      highlight: step.effects.highlight,
      hidden: step.effects.hidden,
      // 透明度参与补间，这里先设成起点值，逐帧更新
      transparent: step.effects.transparent.map((t) => ({
        id: t.id,
        opacity: fromOpacity.get(t.id) ?? 1,
      })),
    });

    deps.playback.set((s) => ({ ...s, narration: step.narration || step.title }));

    // 注视点指向这一步的目标，这样转场结束后用户手动转相机时是绕着目标转的。
    // 只在播放路径做，**不写回 step**（纪律 1）。
    const firstTargetId = step.target.form === 'single' ? step.target.component.id : step.target.from.id;
    const targetComponent = deps.effects.model?.byId.get(firstTargetId);
    if (targetComponent) {
      const [min, max] = [targetComponent.aabb.min, targetComponent.aabb.max];
      deps.viewport.setTarget([
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2,
      ]);
    }

    const duration = Math.max(step.durationMs, 1);
    const start = performance.now();
    // 瞬切模式：时长压到极短，但仍走同一套循环，保证状态一致性
    const effectiveDuration = step.transition === 'cut' ? Math.min(180, duration) : duration;

    cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      const now = performance.now();
      const t = Math.min(1, (now - start) / effectiveDuration);
      const e = ease(t);

      deps.viewport.setPose(interpolatePose(from, to, e));

      // 透明度逐帧插值
      for (const entry of step.effects.transparent) {
        const component = deps.effects.model?.byId.get(entry.id);
        if (!component) continue;
        const startOpacity = fromOpacity.get(entry.id) ?? 1;
        deps.effects.setOpacity(component.object, lerp(startOpacity, entry.opacity, e));
      }

      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        rafId = 0;
        deps.camera.set((s) => ({ ...s, pose: clonePose(to) }));
        onDone();
      }
    };
    rafId = requestAnimationFrame(tick);
  }

  /**
   * 顺序播放。
   *
   * **遇到未求解/失效的步骤暂停**（纪律 2）。`'none'` 与 `'stale'` 的处理不同：
   *  - `'none'`：这一步从来没定过机位，无法播放；
   *  - `'stale'`：有机位，但它是「针对旧目标」的——**播放它可以，但必须提示**，
   *    因为画面看起来正常，只是讲的不是当前目标。
   */
  function stepTo(index: number): void {
    const sb = deps.storyboard.get().storyboard;
    if (index >= sb.steps.length) {
      deps.playback.set((s) => ({ ...s, playing: false, index: -1, blockedReason: null, narration: '' }));
      return;
    }

    const step = sb.steps[index];
    deps.playback.set((s) => ({ ...s, index }));

    if (step.solve === 'none' || step.camera === null) {
      deps.playback.set((s) => ({
        ...s,
        playing: false,
        blockedReason: `第 ${index + 1} 步「${step.title}」尚未求解机位，播放已暂停。请先为它求解后再播放。`,
      }));
      return;
    }

    if (step.solve === 'failed') {
      deps.playback.set((s) => ({
        ...s,
        playing: false,
        blockedReason: `第 ${index + 1} 步「${step.title}」最近一次求解失败，机位可能不符合作者意图，播放已暂停。`,
      }));
      return;
    }

    const stale = step.solve === 'stale';
    if (stale) {
      // 不阻断播放，但明确提示「这一步的机位是针对旧目标解的」
      deps.playback.set((s) => ({
        ...s,
        blockedReason: `第 ${index + 1} 步「${step.title}」的机位尚待按当前意图重算，正在播放旧机位。`,
      }));
    } else {
      setBlocked(null);
    }

    runStep(step, () => {
      if (cancelled) return;
      stepTo(index + 1);
    });
  }

  return {
    play(fromIndex = 0): void {
      const sb = deps.storyboard.get().storyboard;
      if (sb.steps.length === 0) {
        setBlocked('分镜还没有步骤，无法播放');
        return;
      }
      cancelLoop();
      // ★ 纪律 1：播放不改数据。这里从前一步的机位出发，但不写回 step.camera
      deps.playback.set((s) => ({ ...s, playing: true, index: fromIndex, blockedReason: null }));
      stepTo(Math.max(0, fromIndex));
    },

    pause(): void {
      cancelLoop();
      deps.playback.set((s) => ({ ...s, playing: false }));
    },

    stop(): void {
      cancelLoop();
      deps.playback.set((s) => ({ ...s, playing: false, index: -1, blockedReason: null, narration: '' }));
    },

    previewStep(index: number): void {
      const sb = deps.storyboard.get().storyboard;
      const step = sb.steps[index];
      if (!step || !step.camera) return;
      cancelLoop();
      deps.effects.apply(step.effects);
      deps.viewport.setPose(step.camera);
      deps.storyboard.set((s) => ({ ...s, activeStepId: step.id }));
      deps.camera.set((s) => ({ ...s, pose: clonePose(step.camera!) }));
    },

    isPlaying(): boolean {
      return deps.playback.get().playing;
    },
  };
}

/** 结构类型：只为读一个 opacity，避免本文件依赖 three 的运行时类型。 */
interface MeshLike {
  material?: { opacity?: number } | Array<{ opacity?: number }>;
}

/** 读一个对象当前的不透明度（取第一个材质）。 */
function readOpacity(object: unknown): number {
  const mesh = object as MeshLike;
  const material = mesh?.material;
  if (!material) return 1;
  if (Array.isArray(material)) return material[0]?.opacity ?? 1;
  return material.opacity ?? 1;
}

/** 供 UI 显示：总时长。 */
export function totalDuration(steps: StoryboardStep[]): number {
  return steps.reduce((sum, s) => sum + s.durationMs, 0);
}

/** 供 UI 显示：把毫秒格式化成 `1:23`。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export { interpolatePose, ease };
