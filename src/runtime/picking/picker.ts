/**
 * L2 运行时 · M4 射线拾取
 *
 * 依据：《项目概要设计文档》§4.1 的 M4、§2.1（「原有实现保留，包装为接口」）。
 *
 * **为什么包装成接口而不是直接暴露 Raycaster**：因为上层（L5 的视口面板）
 * 只关心「点到哪个构件了」，不关心射线怎么算。而且把 `pointerNdc` 的坐标系
 * 换算（屏幕坐标 → NDC）留在这里，可以避免每个调用点都写一遍那段容易搞错
 * 正负号的换算。
 */
import * as THREE from 'three';
import type { ComponentId } from '../../domain/types/component.ts';
import type { ModelRegistry, RegisteredComponent } from '../model/registry.ts';
import { EffectManager } from '../effects/effects.ts';
import { searchComponents } from '../model/registry.ts';

/** 拾取范围控制：可限制只对某些构件拾取。 */
export type PickFilter = (component: RegisteredComponent) => boolean;

export class Picker {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private registry: ModelRegistry | null = null;
  private effects: EffectManager | null = null;

  attach(registry: ModelRegistry | null, effects: EffectManager): void {
    this.registry = registry;
    this.effects = effects;
  }

  /** 屏幕坐标 → NDC。注意 Y 轴要取反（屏幕向下为正，NDC 向上为正）。 */
  setPointerFromEvent(event: PointerEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * 在给定屏幕位置拾取最近的可见构件。
   *
   * **只对可见构件做拾取**：隐藏的构件如果还能被点到，用户会以为「隐藏失败了」。
   * 这也是竞品（Navisworks）的做法。
   *
   * `filter` 用于「重定向时只允许选同类构件」这类场景（FR-16）。
   */
  pick(
    event: PointerEvent,
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    filter?: PickFilter,
  ): RegisteredComponent | null {
    if (!this.registry) return null;
    this.setPointerFromEvent(event, canvas);
    this.raycaster.setFromCamera(this.pointer, camera);

    const pool = this.registry.components.filter((c) => {
      if (!c.object.visible) return false;
      if (filter && !filter(c)) return false;
      return true;
    });

    const hits = this.raycaster.intersectObjects(pool.map((c) => c.object), false);
    if (hits.length === 0) return null;
    return this.registry.byObject.get(hits[0].object) ?? null;
  }

  /** 按 ID 拾取（不需要屏幕坐标，供列表点击与测试使用）。 */
  byId(id: ComponentId): RegisteredComponent | null {
    return this.registry?.byId.get(id) ?? null;
  }

  /** 模糊搜索（构件面板）。转发给 M1，避免上层直接依赖注册表的内部结构。 */
  search(query: string): RegisteredComponent[] {
    return this.registry ? searchComponents(this.registry, query) : [];
  }

  /** 当前所有可拾取（可见）的构件。 */
  visibleComponents(): RegisteredComponent[] {
    if (!this.registry) return [];
    return this.registry.components.filter((c) => c.object.visible);
  }

  get model(): ModelRegistry | null {
    return this.registry;
  }

  get effectManager(): EffectManager | null {
    return this.effects;
  }
}
