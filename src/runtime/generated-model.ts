/**
 * 运行时：把生成器的纯几何描述翻译成 THREE 对象
 *
 * 规范 §8.4 约束 2 要求生成器「不依赖渲染」——所以领域层只产出数据，
 * 由本文件（L2 运行时层）负责建 mesh。这一分工也顺便满足了任务二 §8.3
 * 给测试同学的需求：几何可以在 Node 下被断言，不需要 WebGL。
 */
import * as THREE from 'three';
import type { GeneratedComponent, MaterialKey, ShapeSpec } from '../domain/model/generate-hall.ts';

/** 生成器几何文件的顶层结构 */
export interface GeometryFile {
  schemaVersion: number;
  prefix: string;
  unit: string;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  components: GeneratedComponent[];
}

/** 材质键 → 实际材质的映射（集中在一处，便于调色） */
export function createMaterials(): Record<MaterialKey, THREE.MeshStandardMaterial> {
  return {
    stone: new THREE.MeshStandardMaterial({ color: '#b9b3a7', roughness: 0.92 }),
    wood: new THREE.MeshStandardMaterial({ color: '#a9693c', roughness: 0.72 }),
    woodDark: new THREE.MeshStandardMaterial({ color: '#7a462a', roughness: 0.68 }),
    roofTile: new THREE.MeshStandardMaterial({ color: '#4b5563', roughness: 0.85 }),
    wall: new THREE.MeshStandardMaterial({ color: '#d8d2c6', roughness: 0.9 }),
    ridge: new THREE.MeshStandardMaterial({ color: '#3a424d', roughness: 0.8 }),
  };
}

/** 依 ShapeSpec 建 geometry；圆柱用 axis 指定轴向 */
function buildGeometry(shape: ShapeSpec): THREE.BufferGeometry {
  switch (shape.form) {
    case 'box':
      return new THREE.BoxGeometry(shape.size[0], shape.size[1], shape.size[2]);
    case 'cylinder': {
      const g = new THREE.CylinderGeometry(
        shape.radius,
        shape.radius,
        shape.height,
        shape.radialSegments,
      );
      // CylinderGeometry 默认沿 +Y；按 axis 转到目标方向
      if (shape.axis === 'x') g.rotateZ(-Math.PI / 2);
      else if (shape.axis === 'z') g.rotateX(Math.PI / 2);
      return g;
    }
    case 'prism': {
      // 悬山山墙：底面沿 Z 展开、高沿 Y、厚度沿 X 的三角柱
      const hb = shape.base / 2;
      const hh = shape.height / 2;
      const ht = shape.thickness / 2;
      const v = [
        -ht, -hh, -hb,  -ht, -hh, hb,  -ht, hh, 0, // 西面
         ht, -hh, -hb,   ht, -hh, hb,   ht, hh, 0, // 东面
      ];
      const idx = [
        0, 1, 2,      // 西面
        3, 5, 4,      // 东面
        0, 2, 5, 0, 5, 3, // 斜面（山面斜边）
        1, 4, 5, 1, 5, 2, // 下沿
        0, 3, 4, 0, 4, 1, // 底面
      ];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      return g;
    }
  }
}

/** 把一个构件转成 THREE.Mesh（名字严格沿用节点名，规范 §3） */
export function buildComponentMesh(
  c: GeneratedComponent,
  materials: Record<MaterialKey, THREE.MeshStandardMaterial>,
): THREE.Mesh {
  const mesh = new THREE.Mesh(buildGeometry(c.shape), materials[c.materialKey]);
  mesh.name = c.nodeName; // ← 语义的唯一来源：名字
  mesh.position.set(c.position[0], c.position[1], c.position[2]);
  // rotX 由领域层算好（generate-hall.ts），这里原样施加，不重新推导
  mesh.rotation.x = c.rotX;
  return mesh;
}

/** 整个模型 → 一个 THREE.Group，子节点名即构件名 */
export function buildModelGroup(file: GeometryFile): THREE.Group {
  const materials = createMaterials();
  const group = new THREE.Group();
  group.name = file.prefix;
  for (const c of file.components) group.add(buildComponentMesh(c, materials));
  return group;
}
