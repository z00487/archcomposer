/**
 * L2 运行时 · M1 模型载入与构件注册
 *
 * 依据：《项目概要设计文档》§4.1 的 M1、§5.3、§7.3 的「搬运而非重写」策略。
 *
 * **职责**：把一棵 THREE 对象树翻译成领域层能懂的东西——
 *  - 给每个 mesh 派生出**稳定 ID** 与**语义标签**（走 L3 的 naming，不自己造）；
 *  - 算出每个构件的 AABB；
 *  - 汇总成 `SceneSummary`（§5.8），这是 L2 向 L3 传几何的**唯一通道**。
 *
 * **为什么 AABB 要在这里算**：因为「包围盒」在 Three.js 里要从几何体算，
 * 而 L3 不许碰 three。所以 L2 必须把它翻译成纯数字数组——这正是 §3.2 说的
 * 「刻意付出的代价」。
 *
 * **世界矩阵的处理**：注册时把每个 mesh 的世界变换**烘焙进 AABB**（用
 * `Box3.setFromObject` 会带世界变换），因此下游拿到的 aabbMin/aabbMax 已经是
 * 世界坐标。这样 L3 不需要再传矩阵，也避免了「同一个构件在不同层级下算出的
 * 包围盒不一致」这类问题。
 */
import * as THREE from 'three';
import type { ComponentId, ComponentSemantics } from '../../domain/types/component.ts';
import type { SceneComponent, SceneSummary } from '../../domain/types/solver.ts';
import { deriveComponentId, deriveSemantics, validateNames } from '../../domain/naming/naming.ts';
import { REPLACEABLE_KINDS } from '../../domain/types/vocabulary.ts';
import type { NameReport } from '../../domain/naming/naming.ts';

/** 一个已注册的构件：运行时对象与领域标识的对应关系。 */
export interface RegisteredComponent {
  /** 领域层的稳定 ID */
  id: ComponentId;
  /** 构件名（= 语义的唯一来源） */
  nodeName: string;
  semantics: ComponentSemantics;
  /** Three.js 对象。**只在 L2/L4/L5 用，不得传进 L3** */
  object: THREE.Object3D;
  aabb: { min: [number, number, number]; max: [number, number, number] };
  /** 中文展示名（语义 label，或兜底名） */
  displayName: string;
}

/**
 * 构件清单：注册结果 + 校验报告 + 模型元信息。
 *
 * **为什么保留 `nameReport` 而不只是打日志**：外部 GLB 的构件名多半不合规范
 * （规范 §5.3 的宽容原则要求「不阻断加载」），但作者需要知道「有多少个构件
 * 其实没有语义」。这份报告直接进 UI 的提示条。
 */
export interface ModelRegistry {
  prefix: string;
  root: THREE.Object3D;
  components: RegisteredComponent[];
  byId: Map<ComponentId, RegisteredComponent>;
  byObject: Map<THREE.Object3D, RegisteredComponent>;
  nameReport: NameReport;
  /** 整体包围盒（世界坐标） */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  label: string;
}

const GROUND_NAME = '场景地面';

/** 收集可拾取的 mesh，排除地面与网格这类「非构件」。 */
export function collectMeshes(root: THREE.Object3D, extraExclude: THREE.Object3D[] = []): THREE.Object3D[] {
  const exclude = new Set<THREE.Object3D>([...extraExclude]);
  const list: THREE.Object3D[] = [];
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (exclude.has(object)) return;
    if ((object.name || '').trim() === GROUND_NAME) return;
    list.push(object);
  });
  return list;
}

/**
 * 注册一棵模型树。
 *
 * **确定性要求**：遍历顺序即 `traverse` 的深度优先顺序，且我们**不排序**——
 * 生成器的节点顺序是稳定的（规范 §8.4 约束 1），排序反而会让「构件列表的顺序」
 * 与「模型里的顺序」不一致，作者在列表里找某个构件时会更费劲。
 */
export function registerModel(
  root: THREE.Object3D,
  prefix: string,
  label: string,
  exclude: THREE.Object3D[] = [],
): ModelRegistry {
  const meshes = collectMeshes(root, exclude);
  const components: RegisteredComponent[] = [];
  const byId = new Map<ComponentId, RegisteredComponent>();
  const byObject = new Map<THREE.Object3D, RegisteredComponent>();
  const nodeNames: string[] = [];

  meshes.forEach((object, index) => {
    const nodeName = (object.name || '').trim() || `unnamed_${String(index + 1).padStart(2, '0')}`;
    nodeNames.push(nodeName);
    const semantics = deriveSemantics(nodeName);
    const id = deriveComponentId(prefix, nodeName);

    const box = new THREE.Box3().setFromObject(object);
    const aabb = {
      min: [box.min.x, box.min.y, box.min.z] as [number, number, number],
      max: [box.max.x, box.max.y, box.max.z] as [number, number, number],
    };

    const entry: RegisteredComponent = {
      id,
      nodeName,
      semantics,
      object,
      aabb,
      displayName: semantics.kind === 'unknown' ? nodeName : semantics.label,
    };

    components.push(entry);
    // ID 冲突不该发生（规范 §7.4 会拦住），但真发生了也要让后来者可见地覆盖，
    // 而不是静默丢一个构件——静默丢构件会让「模型里有 86 个、列表里 85 个」
    // 这种问题极难发现。
    if (byId.has(id)) {
      console.warn(`[M1] 构件 ID 冲突：${id}（节点名 ${nodeName}）覆盖了先前注册的同名构件`);
    }
    byId.set(id, entry);
    byObject.set(object, entry);
  });

  const boundsBox = new THREE.Box3().setFromObject(root);
  const bounds = {
    min: [boundsBox.min.x, boundsBox.min.y, boundsBox.min.z] as [number, number, number],
    max: [boundsBox.max.x, boundsBox.max.y, boundsBox.max.z] as [number, number, number],
  };

  return {
    prefix,
    root,
    components,
    byId,
    byObject,
    nameReport: validateNames(prefix, nodeNames),
    bounds,
    label,
  };
}

/**
 * 把注册结果导出成领域层的 `SceneSummary`（§5.8）。
 *
 * **这是 L2 → L3 的唯一出口**，因此它有两条纪律：
 *  1. 只输出纯数字与字符串，不含任何 THREE 对象；
 *  2. 每次调用都**新建**对象（深拷贝），避免 L3 里的求解器改了摘要又影响到
 *     运行时状态——求解器必须是纯函数，输入被改动就破坏了可复现性。
 */
export function toSceneSummary(registry: ModelRegistry, aspect: number): SceneSummary {
  const components: SceneComponent[] = registry.components.map((c) => ({
    id: c.id,
    semantics: { ...c.semantics },
    aabbMin: [...c.aabb.min] as [number, number, number],
    aabbMax: [...c.aabb.max] as [number, number, number],
    visible: c.object.visible,
    replaceable: REPLACEABLE_KINDS.has(c.semantics.kind),
  }));

  return {
    components,
    boundsMin: [...registry.bounds.min] as [number, number, number],
    boundsMax: [...registry.bounds.max] as [number, number, number],
    aspect: aspect > 0 ? aspect : 1,
    modelPrefix: registry.prefix,
  };
}

/** 按名字取构件（构件面板的搜索用）。大小写不敏感，同时匹配名字与展示名。 */
export function searchComponents(registry: ModelRegistry, query: string): RegisteredComponent[] {
  const q = query.trim().toLowerCase();
  if (!q) return registry.components;
  return registry.components.filter((c) =>
    c.nodeName.toLowerCase().includes(q) ||
    c.displayName.toLowerCase().includes(q) ||
    c.id.toLowerCase().includes(q) ||
    c.semantics.part.includes(q),
  );
}
