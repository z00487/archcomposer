/**
 * L3 领域层 · 运镜求解（把 `CameraMotion` 在时间轴上展开成位姿）
 *
 * 依据：开题报告 §3.5「自动镜头编排」、答辩 PPT 第 9 页的「01 全景环绕 · 360°」。
 *
 * **为什么这一层不碰渲染**：它算出来的是 `Pose` 这个纯数据（位置 + 四元数 + fov），
 * 交给 L2 的 `Viewport.setPose()` 去施加。这样「环绕一周时相机在每个时刻应该在哪」
 * 这件事可以在 Node 下逐帧断言，不需要浏览器。
 *
 * **枢轴的选取规则**（这是本文件唯一有判断的地方）：
 *  1. 运镜自带 `pivot` → 用它（作者显式指定的情形）；
 *  2. 否则用**步骤目标的包围盒中心** → 这是绝大多数情形；
 *  3. 目标不在场景里（如刚载入、ID 还没对上）→ 退回场景整体中心，
 *     让环绕至少能跑起来，而不是抛异常或原地不动。
 *
 * 选「目标中心」而不是「场景中心」作为默认枢轴，是因为讲解时的直觉是
 * 「绕着这根柱子转一圈」，而不是「绕着整个模型转一圈」。
 */
import type { StoryboardStep } from '../types/storyboard.ts';
import type { CameraMotion } from '../types/motion.ts';
import { MotionKind } from '../types/motion.ts';
import type { SceneSummary } from '../types/solver.ts';
import type { Pose, Vec3 } from '../types/geometry.ts';
import { targetIds } from '../types/solver.ts';
import { aabbCenter, orbitAroundPivot } from '../../core/math.ts';

/** 取一步的环绕枢轴。规则见文件头。 */
export function resolveMotionPivot(
  motion: CameraMotion,
  step: StoryboardStep,
  scene: SceneSummary | null,
): Vec3 {
  if (motion.pivot) return motion.pivot;

  if (scene) {
    // 关系型目标（两个构件）取两端包围盒的并，这样环绕能把两端一起扫过
    const boxes = targetIds(step.target)
      .map((id) => scene.components.find((c) => c.id === id))
      .filter((c): c is SceneSummary['components'][number] => Boolean(c));

    if (boxes.length > 0) {
      const min: Vec3 = [Infinity, Infinity, Infinity];
      const max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const c of boxes) {
        for (let i = 0; i < 3; i += 1) {
          min[i] = Math.min(min[i], c.aabbMin[i]);
          max[i] = Math.max(max[i], c.aabbMax[i]);
        }
      }
      return aabbCenter({ min, max });
    }

    // 目标不在场景里：退回整体中心的**水平位置**，但保持目标的高度（通常是 0 附近），
    // 否则环绕一下相机会俯冲到地面以下
    return [
      (scene.boundsMin[0] + scene.boundsMax[0]) / 2,
      (scene.boundsMin[1] + scene.boundsMax[1]) / 2,
      (scene.boundsMin[2] + scene.boundsMax[2]) / 2,
    ];
  }

  return [0, 0, 0];
}

/** 是否存在可用的运镜。 */
export function hasMotion(step: StoryboardStep): boolean {
  return Boolean(step.motion);
}

/**
 * 在时间点 `t ∈ [0,1]` 取这一步的位姿。
 *
 * - **无运镜** → 恒返回 `step.camera`（退化为原来的静态镜头，行为完全不变）；
 * - **有运镜** → 从 `step.camera` 出发，绕枢轴转 `t × degrees` 度。
 *
 * `step.camera` 是**起始**机位而不是终点：环绕结束后相机停在转完的角度上，
 * 下一步再从那里补间过去。把 `camera` 定义成起点而不是终点，是为了让
 * 「重定向重解 camera」与「环绕」这两件事互不干扰——重解给出新起点，
 * 环绕的语义（转多少度）原封不动。
 */
export function poseAtMotion(
  step: StoryboardStep,
  scene: SceneSummary | null,
  t: number,
): Pose | null {
  if (!step.camera) return null;
  const motion = step.motion;
  if (!motion) return step.camera;
  if (motion.kind !== MotionKind.Orbit) return step.camera;

  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const pivot = resolveMotionPivot(motion, step, scene);
  const radians = ((motion.degrees * Math.PI) / 180) * clamped;
  return orbitAroundPivot(step.camera, pivot, radians);
}

/**
 * 环绕结束时的**终点位姿**，与起始机位相对。
 *
 * 用途：下一步补间的起点。播放器每帧都用 `poseAtMotion` 直接算当前位姿，
 * 不需要它；但「环绕结束后往哪继续」需要知道终点，否则转完会跳回起点。
 */
export function motionEndPose(step: StoryboardStep, scene: SceneSummary | null): Pose | null {
  return poseAtMotion(step, scene, 1);
}

/** 供 UI 与文档展示：把这一步的运镜描述成人话（无运镜返回空串）。 */
export function describeStepMotion(step: StoryboardStep): string {
  if (!step.motion) return '';
  return `运镜：环绕 ${Math.round(step.motion.degrees)}°`;
}
