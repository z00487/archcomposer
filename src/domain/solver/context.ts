/**
 * L3 领域层 · 上下文构件集合的推导（M7 / M8 / M9 共用的一个小模块）
 *
 * **什么是「上下文」**：`KEEP_CONTEXT` 意图要「保留结构上下文」，`REVEAL_RELATION`
 * 也要在关系两端之外有参照物。因此必须先回答「哪些构件算上下文」。
 *
 * **为什么单独一个文件**：这个问题在求解（M8）、保真度（M9）、UI 展示三处都要
 * 回答，如果各写一遍，很容易出现「求解时算出来的上下文和保真度评估时的不是同一批」，
 * 于是分数对不上画面——这类 bug 极难定位。
 *
 * **第一版的判定规则**（刻意简单且可解释）：
 *   - 排除目标自身；
 *   - 取**与目标同类**的构件（如讲「东侧斗拱」，其余斗拱就是上下文）；
 *   - 再补上**空间上邻近**的构件（包围盒间距在一定范围内）；
 *   - 只保留当前可见的。
 *
 * 这条规则是可解释的：观众看「东侧斗拱」时，自然而然把其它斗拱和旁边的檩条
 * 当作参照。这也与竞品（Navisworks 的孤立模式）形成对比——它没有「上下文」
 * 这个概念，只有「显示」与「隐藏」。
 */
import type { ComponentId } from '../types/component.ts';
import type { SceneComponent, SceneSummary, TargetRef } from '../types/solver.ts';
import { targetIds } from '../types/solver.ts';
import { aabbCenter, v3distance } from '../../core/math.ts';

/** 邻近判定阈值：两构件中心距离不超过「两构件尺度之和 × 此系数」即算邻近。 */
export const NEIGHBOR_FACTOR = 2.2;

/** 上下文构件数上限。太多会让「保持上下文可见」这个约束实际上无法满足。 */
export const MAX_CONTEXT = 12;

function scaleOf(c: SceneComponent): number {
  return Math.max(
    c.aabbMax[0] - c.aabbMin[0],
    c.aabbMax[1] - c.aabbMin[1],
    c.aabbMax[2] - c.aabbMin[2],
    0.1,
  );
}

/**
 * 推导上下文构件集合。返回的 ID 数组**按确定性顺序**排列（先同类，后邻近；
 * 各自按场景中的原顺序）——顺序稳定才能让保真度分数可复现。
 */
export function computeContextIds(target: TargetRef, scene: SceneSummary): ComponentId[] {
  const exclude = new Set(targetIds(target));
  const targetKinds = targetKindsOf(target);
  const sameKind: ComponentId[] = [];
  const neighbors: ComponentId[] = [];

  for (const c of scene.components) {
    if (exclude.has(c.id)) continue;
    if (!c.visible) continue;
    if (targetKinds.has(c.semantics.kind)) sameKind.push(c.id);
  }

  // 邻近：以目标 AABB 的并集为参照，取一定范围内的可见构件
  const targetComps = targetIds(target)
    .map((id) => scene.components.find((c) => c.id === id))
    .filter((c): c is SceneComponent => c !== undefined);

  if (targetComps.length > 0) {
    const anchor = targetComps[0];
    const anchorCenter = aabbCenter({ min: anchor.aabbMin, max: anchor.aabbMax });
    const anchorScale = scaleOf(anchor);
    for (const c of scene.components) {
      if (exclude.has(c.id)) continue;
      if (!c.visible) continue;
      if (sameKind.includes(c.id)) continue;
      if (neighbors.includes(c.id)) continue;
      const center = aabbCenter({ min: c.aabbMin, max: c.aabbMax });
      const gap = v3distance(anchorCenter, center);
      if (gap <= (anchorScale + scaleOf(c)) * NEIGHBOR_FACTOR) neighbors.push(c.id);
    }
  }

  const merged = [...sameKind, ...neighbors];
  return merged.slice(0, MAX_CONTEXT);
}

function targetKindsOf(target: TargetRef): Set<string> {
  if (target.form === 'single') return new Set([target.component.semantics.kind]);
  return new Set([target.from.semantics.kind, target.to.semantics.kind]);
}

/**
 * 上下文构件的「参照物」筛选——用于 `ShowOverview`：俯瞰时并不需要同类的
 * 那些构件都可见，而是需要**主要结构构件**都可见。这里按类型给了一个优先级：
 * 柱、梁、屋面这类「骨架」优先于檩椽这类「填充」。
 */
export function majorStructureIds(scene: SceneSummary): ComponentId[] {
  const priority: Record<string, number> = {
    plinth: 0,
    column: 1,
    beam: 2,
    dougong: 3,
    roof: 4,
    ridge: 5,
    gable: 6,
    purlin: 7,
    rafter: 8,
    columnbase: 9,
    unknown: 10,
    bracket: 11,
  };
  return [...scene.components]
    .filter((c) => c.visible)
    .sort((a, b) => (priority[a.semantics.kind] ?? 10) - (priority[b.semantics.kind] ?? 10))
    .slice(0, MAX_CONTEXT)
    .map((c) => c.id);
}
