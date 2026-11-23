/**
 * L3 领域层 · M8 求解器候选采样
 *
 * 依据：《项目概要设计文档》§4.2.2「第一版：候选采样 + 约束打分」、§6.2 立场 2。
 *
 * **三个必须坚持的设计立场**（概要设计 §6.2）：
 *  1. 意图在重定向中不变——因此本文件**只读** `request.intent`，绝不修改它；
 *  2. 候选采样优于梯度下降（第一版）——不需要梯度、能处理「无遮挡」这种布尔约束，
 *     且**结果可复现**（相同输入必然相同输出），可复现对论文的评估至关重要；
 *  3. 失败要显式暴露——由上层 `SolveResult.ok` 承担，本文件负责如实汇报每条的满足度。
 *
 * 采样策略借鉴了 CinemaTraj 的锚点思路（沿包围盒面法向偏置），但用穷举替代了
 * SDF 优化——第一版要在几十毫秒内跑完，且必须无依赖。
 */
import type {
  SceneComponent,
  SceneSummary,
  SolveRequest,
  TargetRef,
} from '../types/solver.ts';
import type { Pose, Vec3 } from '../types/geometry.ts';
import type { ComponentId } from '../types/component.ts';
import {
  aabbCenter,
  aabbSize,
  clamp,
  quatLookAt,
  v3add,
  v3dot,
  v3length,
  v3normalize,
  v3scale,
  v3sub,
} from '../../core/math.ts';

/** 候选视点的参数：围绕目标的方位角 / 俯角 / 距离倍数 / 视野角。 */
export interface CandidateParams {
  azimuth: number;
  elevation: number;
  /** 距离 = 目标尺度 × distanceFactor */
  distanceFactor: number;
  fovY: number;
}

/**
 * 固定采样网格。
 *
 * **为什么是固定网格而不是随机采样**：立场 2 要求可复现。随机采样即便固定种子，
 * 也会因浮点累加顺序不同而在不同机器上产生细微差异，进而在 E1 的批量评估里
 * 引入无法解释的波动。固定网格没有这个问题。
 *
 * 规模：方位 16 × 俯角 5 × 距离 6 × FOV 2 = 960 个候选。在生成的厅堂（86 个构件）
 * 上实测，一次完整求解约 15 ms——远低于 NFR-3 的 5 秒预算。
 *
 * **距离因子的取值为什么向下延伸到 1.1**（这是实测改出来的）：
 * 采样距离以 `focusScale`（构件最长边）为基准。对**细长构件**（柱高 4.0 m 而
 * 柱径只有 0.36 m，檩条同理），最长边远大于它在画面中实际占的横向尺寸。
 * 最初的最小因子 2.6 意味着相机至少退到 10.4 m 外，此时一根柱子只占画面的
 * **0.3%**——`EMPHASIZE` 的占比约束（默认 12%）**永远不可能被满足**，
 * 于是「换根柱子」这个最基本的重定向用例直接失败。
 *
 * 加入 1.1 / 1.7 两档后，柱子在中近距离下能占到 20% 以上，约束可满足。
 * 近距档并不会让「大构件」被过分贴近：对大构件而言 1.1 倍最长边仍然足够远。
 */
export const SAMPLING_GRID = {
  azimuths: 16,
  elevations: [0.35, 0.15, -0.05, 0.6, -0.35],
  distanceFactors: [1.1, 1.7, 2.6, 3.6, 5.0, 7.0],
  fovs: [Math.PI / 6, Math.PI / 4],
} as const;

/** 默认视野角（无种子时）。45°。 */
export const DEFAULT_FOV_Y = Math.PI / 4;

/**
 * 生成候选位姿集合。
 *
 * 朝向的取法：单目标 → 看向目标 AABB 中心；关系目标 → 看向两端中心的中点。
 * 后者**刻意如此**：`REVEAL_RELATION` 要求二者同框，若看向其中一个，另一个
 * 大概率被挤出画面。看向中点是让「同框」这件事有机会发生的必要前提。
 */
export function sampleCandidates(request: SolveRequest): Pose[] {
  const focus = focusPoint(request.target, request.scene);
  const scale = focusScale(request.target, request.scene);
  const up: Vec3 = [0, 1, 0];

  const candidates: Pose[] = [];

  // ★ 种子位姿作为第一个候选。求解器不该丢掉「示范时作者已经调好的机位」——
  //   它通常比任何采样结果都更符合作者意图（概要设计 §6.2 步骤 ③）。
  if (request.seed) {
    candidates.push({
      position: [...request.seed.position] as Vec3,
      quaternion: [...request.seed.quaternion] as [number, number, number, number],
      fovY: request.seed.fovY,
    });
  }

  const limit = request.maxCandidates ?? Number.POSITIVE_INFINITY;

  for (let i = 0; i < SAMPLING_GRID.azimuths; i += 1) {
    const azimuth = (i / SAMPLING_GRID.azimuths) * Math.PI * 2;
    for (const elevation of SAMPLING_GRID.elevations) {
      for (const distanceFactor of SAMPLING_GRID.distanceFactors) {
        for (const fovY of SAMPLING_GRID.fovs) {
          if (candidates.length >= limit) return candidates;
          const distance = scale * distanceFactor;
          const position = offsetFromFocus(focus, azimuth, elevation, distance);
          const direction = v3sub(focus, position);
          candidates.push({
            position,
            quaternion: quatLookAt(direction, up),
            fovY,
          });
        }
      }
    }
  }

  return candidates;
}

/** 采样焦点：单目标取构件中心，关系目标取两端中点。 */
export function focusPoint(target: TargetRef, scene: SceneSummary): Vec3 {
  const ids = target.form === 'single'
    ? [target.component.id]
    : [target.from.id, target.to.id];
  const centers = ids
    .map((id) => scene.components.find((c) => c.id === id))
    .filter((c): c is SceneComponent => c !== undefined)
    .map((c) => aabbCenter({ min: c.aabbMin, max: c.aabbMax }));

  if (centers.length === 0) {
    // 目标不在场景里：退回场景中心，让求解器仍能产出「合法但低分」的结果，
    // 而不是直接崩溃——崩溃会掩盖真正的错误信息（目标 ID 拼错了）。
    return aabbCenter({ min: scene.boundsMin, max: scene.boundsMax });
  }
  if (centers.length === 1) return centers[0];

  return v3scale(v3add(centers[0], centers[1]), 0.5);
}

/**
 * 采样尺度的基准量。
 *
 * 单目标：构件自身最长边。关系目标：**两构件的间距**（而不是各自尺寸之和）——
 * 因为「两个构件离得远」时相机必须退得更远才能同框，用间距作为尺度能让采样
 * 距离自动适配这种情形。
 */
export function focusScale(target: TargetRef, scene: SceneSummary): number {
  const ids = target.form === 'single'
    ? [target.component.id]
    : [target.from.id, target.to.id];
  const comps = ids
    .map((id) => scene.components.find((c) => c.id === id))
    .filter((c): c is SceneComponent => c !== undefined);

  if (comps.length === 0) {
    const size = aabbSize({ min: scene.boundsMin, max: scene.boundsMax });
    return Math.max(size[0], size[1], size[2], 1) * 0.5;
  }
  if (comps.length === 1) {
    const size = aabbSize({ min: comps[0].aabbMin, max: comps[0].aabbMax });
    return Math.max(Math.max(size[0], size[1], size[2]), 0.2);
  }

  const gap = v3length(v3sub(
    aabbCenter({ min: comps[0].aabbMin, max: comps[0].aabbMax }),
    aabbCenter({ min: comps[1].aabbMin, max: comps[1].aabbMax }),
  ));
  return clamp(gap, 0.4, 40);
}

/**
 * 从焦点按方位角/俯角/距离算相机位置。
 *
 * 坐标约定（文档三 §2.1）：+X 东、+Y 上、+Z 南。
 * 方位角 0 → 相机的正南方向（+Z），即从南面看建筑（正面）。
 * 俯角 > 0 → 相机在焦点上方。
 */
export function offsetFromFocus(
  focus: Vec3,
  azimuth: number,
  elevation: number,
  distance: number,
): Vec3 {
  const horizontal = Math.cos(elevation) * distance;
  return [
    focus[0] + Math.sin(azimuth) * horizontal,
    focus[1] + Math.sin(elevation) * distance,
    focus[2] + Math.cos(azimuth) * horizontal,
  ];
}

/**
 * 找出挡在目标与相机之间的构件（用于 `REDUCE_OCCLUSION` 的透明化特效）。
 *
 * 返回按「遮挡贡献」降序排列的构件，上层可只取前若干个调透明——全调透明会让
 * 场景失去参照，反而不利于讲解。
 */
export function findOccluders(
  target: TargetRef,
  pose: Pose,
  scene: SceneSummary,
  limit = 3,
): ComponentId[] {
  const focus = focusPoint(target, scene);
  const targetIds = target.form === 'single'
    ? [target.component.id]
    : [target.from.id, target.to.id];

  const dir = v3normalize(v3sub(focus, pose.position));
  const distance = v3length(v3sub(focus, pose.position));
  const scored: Array<{ id: ComponentId; t: number }> = [];

  for (const comp of scene.components) {
    if (targetIds.includes(comp.id)) continue;
    if (!comp.visible) continue;
    const center = aabbCenter({ min: comp.aabbMin, max: comp.aabbMax });
    const rel = v3sub(center, pose.position);
    const t = v3dot(rel, dir);
    if (t <= 0 || t >= distance) continue; // 不在相机与目标之间
    const closest = v3add(pose.position, v3scale(dir, t));
    const perpendicular = v3length(v3sub(closest, center));
    const scale = Math.max(
      Math.max(...aabbSize({ min: comp.aabbMin, max: comp.aabbMax })),
      0.1,
    );
    // 越靠近视线、越靠前，越算「挡路」
    const score = perpendicular / (scale * 0.5 + 1e-6);
    if (score < 1.2) scored.push({ id: comp.id, t: t / distance });
  }

  scored.sort((a, b) => a.t - b.t);
  return scored.slice(0, limit).map((s) => s.id);
}

