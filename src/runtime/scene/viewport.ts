/**
 * L2 运行时 · M2 场景装配与相机
 *
 * 依据：《项目概要设计文档》§4.1 的 M2、§7.3「`createDemoBuilding` 移到
 * `runtime/model/` 并保留作为无模型时的兜底」。
 *
 * **本模块把「三位一体」的东西（scene / camera / renderer / controls）收在一处**，
 * 对外只暴露少量方法。这样 `main.ts` 就真的只剩装配，逻辑全在各层里（§7.3）。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Pose } from '../../domain/types/geometry.ts';
import { clonePose } from '../../core/math.ts';

export interface ViewportSize {
  width: number;
  height: number;
}

/** 场景装配的配置。默认值取自原型的观感（§7.3 的「搬运而非重写」）。 */
export interface SceneOptions {
  background?: string;
  fogNear?: number;
  fogFar?: number;
  groundY?: number;
}

export class Viewport {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly ground: THREE.Mesh;
  readonly grid: THREE.GridHelper;

  private readonly container: HTMLElement;
  /** 当前已经挂进 scene 的模型根，用于切模型时把上一棵摘掉。 */
  private framedRoot: THREE.Object3D | null = null;

  constructor(container: HTMLElement, options: SceneOptions = {}) {
    const background = options.background ?? '#eaf0f5';
    const groundY = options.groundY ?? -0.46;

    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(background);
    this.scene.fog = new THREE.Fog(background, options.fogNear ?? 22, options.fogFar ?? 65);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    this.camera.position.set(10, 8, 12);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(0, 1.8, 0);
    this.controls.minDistance = 3;
    this.controls.maxDistance = 40;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9bad, 2.0));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.0);
    keyLight.position.set(8, 14, 7);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xd7e8ff, 1.2);
    fillLight.position.set(-8, 7, -6);
    this.scene.add(fillLight);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100),
      new THREE.MeshStandardMaterial({ color: '#dce4eb', roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = groundY;
    this.ground.receiveShadow = true;
    this.ground.name = '场景地面';
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(40, 40, 0xb6c5d3, 0xd0dbe4);
    this.grid.position.y = groundY + 0.01;
    this.scene.add(this.grid);

    this.resize();
  }

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get aspect(): number {
    return this.camera.aspect;
  }

  size(): ViewportSize {
    return { width: this.container.clientWidth, height: this.container.clientHeight };
  }

  resize(): void {
    const { width, height } = this.size();
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /**
   * 把整个模型纳入视野。
   *
   * `keepOrigin` 为 true 时**不重新居中**——生成器的模型已按规范 §2.2 把原点放在
   * 平面中心 + 台基顶面，再平移会破坏「柱子中心在原点正上方」这一可断言的性质。
   * 外部 GLB 则相反，通常需要居中以获得合适的初始视角。
   */
  frame(root: THREE.Object3D, keepOrigin = false): { size: THREE.Vector3; center: THREE.Vector3 } {
    // **模型必须真的进场景**：注册、拾取、特效都只持有对象引用，谁都不负责把它
    // 挂到 scene 上。少了这一段，界面会显示「86 个构件」而画面空无一物——
    // 因为 Box3 从对象自身算得出来，渲染却只认 scene 的子树。
    // 切模型时先把上一棵摘掉，避免新旧两棵树叠在场景里。
    if (this.framedRoot && this.framedRoot !== root) this.scene.remove(this.framedRoot);
    if (!this.scene.children.includes(root)) this.scene.add(root);
    this.framedRoot = root;

    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (box.isEmpty()) return { size, center };

    if (!keepOrigin) root.position.sub(center);
    const focusY = keepOrigin ? size.y * 0.42 : Math.max(0.8, size.y * 0.42);
    this.controls.target.set(0, focusY, 0);

    const maxDim = Math.max(size.x, size.y, size.z, 2);
    this.camera.position.set(maxDim * 1.35, maxDim * 0.95, maxDim * 1.55);
    this.camera.near = Math.max(0.01, maxDim / 1000);
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = maxDim * 0.12;
    this.controls.maxDistance = maxDim * 8;
    this.controls.update();
    return { size, center };
  }

  /** 重置到初始视角（顶栏的「重置视角」按钮）。 */
  resetView(root: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 2);
    this.controls.target.set(0, Math.max(0.8, size.y * 0.42), 0);
    this.camera.position.set(maxDim * 1.35, maxDim * 0.95, maxDim * 1.55);
    this.controls.update();
  }

  // ── 位姿的读 / 写：L2 与 L3 之间的翻译 ────────────────────────

  /** 当前相机位姿 → 领域层的纯数据 `Pose`。 */
  getPose(): Pose {
    return {
      position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      quaternion: [
        this.camera.quaternion.x,
        this.camera.quaternion.y,
        this.camera.quaternion.z,
        this.camera.quaternion.w,
      ],
      fovY: (this.camera.fov * Math.PI) / 180,
    };
  }

  /** 领域层的 `Pose` → 施加到相机上。 */
  setPose(pose: Pose): void {
    this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    this.camera.quaternion.set(
      pose.quaternion[0],
      pose.quaternion[1],
      pose.quaternion[2],
      pose.quaternion[3],
    );
    this.camera.fov = (pose.fovY * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 只改 OrbitControls 的目标点，不动相机。
   *
   * 重定向求解器会同时给出新机位与新注视点；若只 setPose 而不更新 target，
   * 用户第一次拖动鼠标时相机会突然跳回旧目标——这是很典型的「看着没问题、
   * 一动就崩」的 bug。
   */
  setTarget(target: [number, number, number]): void {
    this.controls.target.set(target[0], target[1], target[2]);
    this.controls.update();
  }

  /** 深拷贝当前位姿（用于示范录制的快照）。 */
  snapshotPose(): Pose {
    return clonePose(this.getPose());
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
