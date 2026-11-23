/**
 * L2 运行时 · M3 视觉效果（高亮 / 透明 / 隐藏）
 *
 * 依据：《项目概要设计文档》§4.1 的 M3、§7.3 的「搬运而非重写」策略
 * （原 `main.ts` 里的 `rememberState` / `setHighlight` / `restoreObject` 移到这里）。
 *
 * **核心设计：材质状态快照。** 每个构件的材质状态（颜色、自发光、透明度、
 * 是否透明、是否写深度）在首次触碰前被记下来，之后任何特效都能被完整撤销，
 * 回到模型出厂状态。
 *
 * **为什么必须 clone 材质**：GLTF/程序化模型里多个构件常常**共享同一个材质实例**，
 * 若直接改材质属性，改一个构件会连带改掉所有共享它的构件——这是「调透明一根柱子，
 * 结果所有柱子都透明了」这类 bug 的根源。
 */
import * as THREE from 'three';
import type { ComponentId } from '../../domain/types/component.ts';
import type { VisualEffects } from '../../domain/types/solver.ts';
import type { ModelRegistry, RegisteredComponent } from '../model/registry.ts';

/** 一个材质的可恢复状态快照。 */
interface MaterialSnapshot {
  material: THREE.Material;
  color?: THREE.Color;
  emissive?: THREE.Color;
  emissiveIntensity?: number;
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}

/** 高亮色与强度，集中在一处便于调。 */
export const HIGHLIGHT_COLOR = '#ff8a24';
export const HIGHLIGHT_INTENSITY = 0.85;

export function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh || !mesh.material) return [];
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

/**
 * 特效管理器：以**构件 ID** 为键施加视觉状态，而不是以 THREE 对象为键。
 *
 * **为什么用 ID 而不是对象引用**：因为 `VisualEffects`（领域层）里存的就是 ID
 * （约束 C-4：纯数据、可 JSON 序列化）。分镜文件里不可能存 THREE 对象，
 * 所以施放特效时必须先做一次「ID → 对象」的解析。这个解析放在这里，
 * 让上层（L4）完全不用碰 three。
 */
export class EffectManager {
  private readonly snapshots = new WeakMap<THREE.Object3D, MaterialSnapshot[]>();
  /**
   * 当前被高亮的对象。
   *
   * ⚠️ **不能用 WeakSet**：`WeakSet` 没有 `clear()`，而切换模型或重放分镜时必须
   * 能整体清空。用普通 `Set` 会持有对象引用，所以这里靠 `attach()` 时重建来避免
   * 泄漏——模型切换本来就不频繁。
   */
  private highlighted = new Set<THREE.Object3D>();
  private registry: ModelRegistry | null = null;

  /** 切换模型时调用：换掉注册表并清空特效。 */
  attach(registry: ModelRegistry | null): void {
    this.registry = registry;
    this.highlighted = new Set();
  }

  get model(): ModelRegistry | null {
    return this.registry;
  }

  /** 首次触碰某对象前记录其材质状态。可重复调用，只记一次。 */
  remember(object: THREE.Object3D): void {
    if (this.snapshots.has(object)) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && mesh.material) {
      // clone：避免改动影响共享同一材质实例的其它构件
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map((m) => m.clone())
        : mesh.material.clone();
    }
    this.snapshots.set(
      object,
      materialsOf(object).map((material) => {
        const m = material as THREE.MeshStandardMaterial;
        return {
          material,
          color: m.color?.clone(),
          emissive: m.emissive?.clone(),
          emissiveIntensity: m.emissiveIntensity,
          opacity: material.opacity,
          transparent: material.transparent,
          depthWrite: material.depthWrite,
        };
      }),
    );
  }

  isHighlighted(object: THREE.Object3D): boolean {
    return this.highlighted.has(object);
  }

  setHighlight(object: THREE.Object3D, enabled: boolean): void {
    this.remember(object);
    for (const material of materialsOf(object)) {
      const m = material as THREE.MeshStandardMaterial;
      if (enabled && m.emissive) {
        m.emissive.set(HIGHLIGHT_COLOR);
        m.emissiveIntensity = HIGHLIGHT_INTENSITY;
      } else if (m.emissive) {
        const snapshot = this.snapshots.get(object)?.find((s) => s.material === material);
        m.emissive.copy(snapshot?.emissive ?? new THREE.Color(0));
        m.emissiveIntensity = snapshot?.emissiveIntensity ?? 1;
      }
      material.needsUpdate = true;
    }
    if (enabled) this.highlighted.add(object);
    else this.highlighted.delete(object);
  }

  setOpacity(object: THREE.Object3D, opacity: number): void {
    this.remember(object);
    for (const material of materialsOf(object)) {
      material.transparent = opacity < 1;
      material.opacity = opacity;
      // depthWrite 必须跟着走：半透明还写深度会导致自身的背面被裁掉，出现「空洞」
      material.depthWrite = opacity >= 1;
      material.needsUpdate = true;
    }
  }

  setVisible(object: THREE.Object3D, visible: boolean): void {
    object.visible = visible;
  }

  /** 恢复单个构件的出厂状态。 */
  restore(object: THREE.Object3D): void {
    const snapshots = this.snapshots.get(object) ?? [];
    for (const state of snapshots) {
      const material = state.material as THREE.MeshStandardMaterial;
      if (state.color && material.color) material.color.copy(state.color);
      if (state.emissive && material.emissive) material.emissive.copy(state.emissive);
      if (state.emissiveIntensity !== undefined && 'emissiveIntensity' in material) {
        material.emissiveIntensity = state.emissiveIntensity;
      }
      material.opacity = state.opacity;
      material.transparent = state.transparent;
      material.depthWrite = state.depthWrite;
      material.needsUpdate = true;
    }
    object.visible = true;
    this.highlighted.delete(object);
  }

  /** 恢复全部构件（切换模型、退出分镜播放时调用）。 */
  restoreAll(): void {
    if (!this.registry) return;
    for (const c of this.registry.components) this.restore(c.object);
  }

  /**
   * 施加一组 `VisualEffects`。
   *
   * **实现方式是「先全部复原，再施加」**，而不是「算出与上一组效果的差集」。
   * 理由：差分实现要维护「上一组效果」的状态，任何一处漏掉更新就会留下
   * 「幽灵高亮」；而全量复位在这个体量（86 个构件）下只需几毫秒，
   * 换来的是**幂等性**——同一组特效施加两次的结果必然相同。
   */
  apply(effects: VisualEffects): void {
    if (!this.registry) return;
    this.restoreAll();

    for (const id of effects.highlight) {
      const entry = this.byId(id);
      if (entry) this.setHighlight(entry.object, true);
    }
    for (const t of effects.transparent) {
      const entry = this.byId(t.id);
      if (entry) this.setOpacity(entry.object, t.opacity);
    }
    for (const id of effects.hidden) {
      const entry = this.byId(id);
      if (entry) this.setVisible(entry.object, false);
    }
  }

  /**
   * 从当前场景状态**反向导出**一组 `VisualEffects`。
   *
   * 用途：示范录制（M5）与保存分镜。这里只能读出「高亮、透明、隐藏」三类可表达
   * 的状态；像「材质颜色被就地改过」这类不在 `VisualEffects` 里的变化会被忽略，
   * 这是有意的——分镜只记录可复现的语义状态。
   */
  capture(): VisualEffects {
    const effects: VisualEffects = { highlight: [], transparent: [], hidden: [] };
    if (!this.registry) return effects;
    for (const c of this.registry.components) {
      if (!c.object.visible) effects.hidden.push(c.id);
      if (this.highlighted.has(c.object)) effects.highlight.push(c.id);
      const material = materialsOf(c.object)[0];
      if (material && material.opacity < 1) {
        effects.transparent.push({ id: c.id, opacity: Number(material.opacity.toFixed(3)) });
      }
    }
    return effects;
  }

  private byId(id: ComponentId): RegisteredComponent | undefined {
    return this.registry?.byId.get(id);
  }
}
