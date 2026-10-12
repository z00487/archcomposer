import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <div class="brand-mark">A</div>
    <div class="brand-copy"><strong>ArchComposer</strong><span>建筑三维可视化解说编创 · Demo 01</span></div>
    <div class="top-status"><i></i> 三维场景运行中</div>
  </header>
  <main class="workspace">
    <section class="viewport-panel">
      <div class="viewport-head"><div><strong>三维场景</strong><span id="scene-subtitle">示例建筑 · 可交互预览</span></div><button id="reset-camera" class="quiet-button">⟲ 重置视角</button></div>
      <div id="viewport" class="viewport">
        <div class="viewport-hint">左键拖动旋转 · 滚轮缩放 · 右键平移</div>
        <div id="loading" class="loading">正在构建三维场景…</div>
        <div id="toast" class="toast"></div>
      </div>
      <div class="viewport-footer"><span><b class="dot blue"></b> 左键选择构件</span><span><b class="dot orange"></b> 橙色表示当前选中</span><span id="object-count">构件 0</span></div>
    </section>
    <aside class="side-panel">
      <section class="side-section intro"><div class="eyebrow">INSPECTOR</div><h1>构件检查器</h1><p>选择建筑构件，并调整它在讲解中的视觉表现。</p></section>
      <section class="side-section"><div class="section-title"><strong>构件列表</strong><span id="component-count" class="count-pill">0</span></div><div id="component-list" class="component-list"><div class="empty-state">场景初始化中…</div></div></section>
      <section class="side-section selected-section"><div class="section-title"><strong>当前构件</strong><span class="live-label">LIVE</span></div><div id="selected-name" class="selected-name">尚未选择构件</div><div id="selected-type" class="muted">点击场景中的构件开始编辑</div>
        <div class="control-block"><div class="control-label"><label for="opacity">透明度</label><strong id="opacity-value">100%</strong></div><input id="opacity" type="range" min="10" max="100" value="100" disabled /><div class="range-ends"><span>更透明</span><span>不透明</span></div></div>
        <div class="action-grid"><button id="highlight" class="action-button primary" disabled><span>✦</span> 高亮构件</button><button id="toggle-visible" class="action-button" disabled><span>◉</span> 隐藏构件</button></div>
        <button id="restore" class="restore-button" disabled>恢复该构件默认状态</button>
      </section>
      <section class="side-section tips"><div class="section-title"><strong>操作说明</strong></div><ol><li>在左侧场景中点击建筑构件。</li><li>使用高亮突出讲解目标。</li><li>拖动透明度滑块观察内部结构。</li><li>隐藏构件后，可从构件列表恢复选择。</li></ol></section>
      <section class="side-section model-section"><div class="section-title"><strong>加载自定义模型</strong></div><p class="muted small">支持本地 .glb / .gltf 文件。建议优先使用 GLB 单文件模型。</p><label class="upload-button" for="model-file">＋ 选择 GLB / GLTF 文件</label><input id="model-file" type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" hidden /></section>
    </aside>
  </main>
  <footer class="app-footer"><span>ArchComposer · Three.js + TypeScript</span><span>阶段一：三维场景与构件视觉操作</span></footer>
`;

const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const loading = document.querySelector<HTMLDivElement>('#loading')!;
const toast = document.querySelector<HTMLDivElement>('#toast')!;
const componentList = document.querySelector<HTMLDivElement>('#component-list')!;
const selectedName = document.querySelector<HTMLDivElement>('#selected-name')!;
const selectedType = document.querySelector<HTMLDivElement>('#selected-type')!;
const opacitySlider = document.querySelector<HTMLInputElement>('#opacity')!;
const opacityValue = document.querySelector<HTMLElement>('#opacity-value')!;
const highlightButton = document.querySelector<HTMLButtonElement>('#highlight')!;
const visibilityButton = document.querySelector<HTMLButtonElement>('#toggle-visible')!;
const restoreButton = document.querySelector<HTMLButtonElement>('#restore')!;
const modelFile = document.querySelector<HTMLInputElement>('#model-file')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#eaf0f5');
scene.fog = new THREE.Fog('#eaf0f5', 22, 65);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
camera.position.set(10, 8, 12);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
viewport.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 1.8, 0);
controls.minDistance = 3;
controls.maxDistance = 40;

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9bad, 2.0));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.0);
keyLight.position.set(8, 14, 7); keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048); scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xd7e8ff, 1.2); fillLight.position.set(-8, 7, -6); scene.add(fillLight);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), new THREE.MeshStandardMaterial({ color: '#dce4eb', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -0.04; ground.receiveShadow = true; ground.name = '场景地面'; scene.add(ground);
const grid = new THREE.GridHelper(40, 40, 0xb6c5d3, 0xd0dbe4); grid.position.y = -0.025; scene.add(grid);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let root: THREE.Object3D | null = null;
let selected: THREE.Object3D | null = null;
let selectable: THREE.Object3D[] = [];
let toastTimer = 0;
type MaterialState = { material: THREE.Material; color?: THREE.Color; emissive?: THREE.Color; emissiveIntensity?: number; opacity: number; transparent: boolean; depthWrite: boolean };
const initialStates = new WeakMap<THREE.Object3D, MaterialState[]>();
const originalNames = new WeakMap<THREE.Object3D, string>();
const highlighted = new WeakSet<THREE.Object3D>();

function materialsOf(object: THREE.Object3D): THREE.Material[] {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh || !mesh.material) return [];
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}
function rememberState(object: THREE.Object3D) {
  if (initialStates.has(object)) return;
  // Clone mesh materials so editing one mesh does not unintentionally affect other meshes sharing a GLTF material.
  const mesh = object as THREE.Mesh;
  if (mesh.isMesh && mesh.material) {
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(material => material.clone()) : mesh.material.clone();
  }
  initialStates.set(object, materialsOf(object).map(material => {
    const m = material as THREE.MeshStandardMaterial;
    return { material, color: m.color?.clone(), emissive: m.emissive?.clone(), emissiveIntensity: m.emissiveIntensity, opacity: material.opacity, transparent: material.transparent, depthWrite: material.depthWrite };
  }));
  originalNames.set(object, object.name || '未命名构件');
}
function setHighlight(object: THREE.Object3D, enabled: boolean) {
  materialsOf(object).forEach(material => {
    const m = material as THREE.MeshStandardMaterial;
    if (enabled && m.emissive) { m.emissive.set('#ff8a24'); m.emissiveIntensity = 0.85; }
    else {
      const state = initialStates.get(object)?.find(s => s.material === material);
      if (state && m.emissive) { m.emissive.copy(state.emissive ?? new THREE.Color(0)); m.emissiveIntensity = state.emissiveIntensity ?? 1; }
    }
    material.needsUpdate = true;
  });
  if (enabled) highlighted.add(object); else highlighted.delete(object);
}
function restoreObject(object: THREE.Object3D) {
  const states = initialStates.get(object) ?? [];
  states.forEach(state => {
    const material = state.material as THREE.MeshStandardMaterial;
    if (state.color && material.color) material.color.copy(state.color);
    if (state.emissive && material.emissive) material.emissive.copy(state.emissive);
    if (state.emissiveIntensity !== undefined && 'emissiveIntensity' in material) material.emissiveIntensity = state.emissiveIntensity;
    material.opacity = state.opacity; material.transparent = state.transparent; material.depthWrite = state.depthWrite; material.needsUpdate = true;
  });
  object.visible = true; highlighted.delete(object);
}
function toastMessage(message: string) {
  toast.textContent = message; toast.classList.add('show');
  window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2300);
}
function meshObjects(container: THREE.Object3D): THREE.Object3D[] {
  const list: THREE.Object3D[] = [];
  container.traverse(object => { if ((object as THREE.Mesh).isMesh && object !== ground) list.push(object); });
  return list;
}
function safeName(object: THREE.Object3D, index: number) {
  if (!originalNames.has(object)) originalNames.set(object, object.name?.trim() || `建筑构件 ${String(index + 1).padStart(2, '0')}`);
  return originalNames.get(object)!;
}
function rebuildComponentList() {
  componentList.innerHTML = '';
  selectable.forEach((object, index) => {
    const row = document.createElement('button'); row.className = 'component-row'; row.dataset.index = String(index);
    if (object === selected) row.classList.add('active');
    if (!object.visible) row.classList.add('is-hidden');
    const type = (object as THREE.Mesh).geometry?.type ?? 'Mesh';
    row.innerHTML = `<span class="component-icon">${object.visible ? '◇' : '◌'}</span><span class="component-copy"><strong></strong><small></small></span><span class="row-eye">${object.visible ? '●' : '○'}</span>`;
    row.querySelector('strong')!.textContent = safeName(object, index);
    row.querySelector('small')!.textContent = type + (highlighted.has(object) ? ' · 已高亮' : '');
    row.addEventListener('click', () => { if (!object.visible) { object.visible = true; } selectObject(object); });
    componentList.appendChild(row);
  });
  document.querySelector('#component-count')!.textContent = String(selectable.length);
  document.querySelector('#object-count')!.textContent = `构件 ${selectable.length}`;
}
function selectObject(object: THREE.Object3D | null) {
  if (selected && selected !== object && highlighted.has(selected)) setHighlight(selected, false);
  selected = object;
  document.querySelectorAll<HTMLButtonElement>('.component-row').forEach(row => row.classList.toggle('active', Number(row.dataset.index) === selectable.indexOf(object!)));
  if (!object) {
    selectedName.textContent = '尚未选择构件'; selectedType.textContent = '点击场景中的构件开始编辑';
    opacitySlider.disabled = highlightButton.disabled = visibilityButton.disabled = restoreButton.disabled = true;
  } else {
    selectedName.textContent = safeName(object, selectable.indexOf(object));
    selectedType.textContent = `${(object as THREE.Mesh).geometry?.type ?? '3D Object'} · ${object.visible ? '可见' : '已隐藏'}`;
    opacitySlider.disabled = highlightButton.disabled = visibilityButton.disabled = restoreButton.disabled = false;
    const material = materialsOf(object)[0];
    const opacity = material ? Math.round(material.opacity * 100) : 100;
    opacitySlider.value = String(opacity); opacityValue.textContent = `${opacity}%`;
    highlightButton.classList.toggle('is-active', highlighted.has(object));
    visibilityButton.innerHTML = object.visible ? '<span>◉</span> 隐藏构件' : '<span>◉</span> 显示构件';
  }
  rebuildComponentList();
}
function registerRoot(object: THREE.Object3D, label: string) {
  if (root) scene.remove(root);
  root = object; scene.add(root);
  selectable = meshObjects(root);
  selectable.forEach((mesh, i) => { rememberState(mesh); safeName(mesh, i); mesh.castShadow = true; mesh.receiveShadow = true; });
  const box = new THREE.Box3().setFromObject(root);
  if (!box.isEmpty()) {
    const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3());
    root.position.sub(center); // center model around world origin
    controls.target.set(0, Math.max(0.8, size.y * 0.42), 0);
    const maxDim = Math.max(size.x, size.y, size.z, 2);
    camera.position.set(maxDim * 1.35, maxDim * 0.95, maxDim * 1.55);
    camera.near = Math.max(0.01, maxDim / 1000); camera.far = maxDim * 100; camera.updateProjectionMatrix();
    controls.minDistance = maxDim * 0.12; controls.maxDistance = maxDim * 8;
  }
  controls.update();
  document.querySelector('#scene-subtitle')!.textContent = label;
  loading.classList.add('hidden'); selectObject(null); rebuildComponentList();
}
function createDemoBuilding(): THREE.Group {
  const building = new THREE.Group(); building.name = '示例建筑';
  const mats = {
    wall: new THREE.MeshStandardMaterial({ color: '#d9dfe4', roughness: 0.78 }),
    glass: new THREE.MeshStandardMaterial({ color: '#75a9c4', roughness: 0.24, metalness: 0.12 }),
    roof: new THREE.MeshStandardMaterial({ color: '#526575', roughness: 0.8 }),
    column: new THREE.MeshStandardMaterial({ color: '#f0eee8', roughness: 0.65 }),
    base: new THREE.MeshStandardMaterial({ color: '#aab7c2', roughness: 0.9 }),
    accent: new THREE.MeshStandardMaterial({ color: '#bd8052', roughness: 0.72 }),
  };
  function block(name: string, size: [number, number, number], pos: [number, number, number], material: THREE.Material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material); mesh.name = name; mesh.position.set(...pos); building.add(mesh); return mesh;
  }
  block('建筑基座', [8.8, 0.35, 6.8], [0, 0.18, 0], mats.base);
  block('一层主体', [6.8, 2.7, 4.8], [0, 1.7, 0], mats.wall);
  block('二层主体', [5.8, 2.4, 4.2], [0, 4.25, 0], mats.wall);
  block('屋顶', [6.5, 0.3, 4.8], [0, 5.6, 0], mats.roof);
  block('入口门廊顶板', [2.8, 0.18, 1.5], [0, 2.8, 3.0], mats.accent);
  for (const x of [-1.1, 1.1]) block(`门廊柱 ${x < 0 ? '左' : '右'}`, [0.18, 2.45, 0.18], [x, 1.48, 3.45], mats.column);
  block('入口门', [1.15, 2.05, 0.12], [0, 1.25, 2.43], mats.roof);
  // Front-facing windows on both storeys.
  for (const x of [-2.35, -0.85, 0.85, 2.35]) {
    block(`一层窗 ${x}`, [0.78, 1.15, 0.08], [x, 1.72, 2.44], mats.glass);
    block(`二层窗 ${x}`, [0.8, 1.0, 0.08], [x * 0.82, 4.25, 2.14], mats.glass);
  }
  // Side windows and simple vertical facade fins.
  for (const z of [-1.25, 0.2, 1.35]) block(`侧窗 ${z}`, [0.08, 1.1, 0.72], [3.42, 1.7, z], mats.glass);
  for (const x of [-2.6, 2.6]) block(`立面装饰线 ${x}`, [0.1, 2.45, 0.12], [x, 4.25, 2.13], mats.accent);
  return building;
}
function onResize() {
  const width = viewport.clientWidth, height = viewport.clientHeight;
  camera.aspect = width / Math.max(height, 1); camera.updateProjectionMatrix(); renderer.setSize(width, height);
}
function onPointerDown(event: PointerEvent) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(selectable.filter(object => object.visible), false);
  if (hits.length) selectObject(hits[0].object);
  else selectObject(null);
}
renderer.domElement.addEventListener('pointerdown', onPointerDown);
document.querySelector('#reset-camera')!.addEventListener('click', () => {
  if (!root) return;
  const box = new THREE.Box3().setFromObject(root); const size = box.getSize(new THREE.Vector3()); const maxDim = Math.max(size.x, size.y, size.z, 2);
  controls.target.set(0, Math.max(0.8, size.y * 0.42), 0); camera.position.set(maxDim * 1.35, maxDim * 0.95, maxDim * 1.55); controls.update(); toastMessage('已重置相机视角');
});
highlightButton.addEventListener('click', () => {
  if (!selected) return;
  const enable = !highlighted.has(selected); setHighlight(selected, enable); highlightButton.classList.toggle('is-active', enable); rebuildComponentList(); toastMessage(enable ? '已高亮当前构件' : '已取消高亮');
});
opacitySlider.addEventListener('input', () => {
  if (!selected) return;
  const opacity = Number(opacitySlider.value) / 100; opacityValue.textContent = `${Math.round(opacity * 100)}%`;
  materialsOf(selected).forEach(material => { material.transparent = opacity < 1; material.opacity = opacity; material.depthWrite = opacity >= 1; material.needsUpdate = true; });
});
visibilityButton.addEventListener('click', () => {
  if (!selected) return;
  selected.visible = !selected.visible; const hidden = !selected.visible;
  selectedType.textContent = `${(selected as THREE.Mesh).geometry?.type ?? '3D Object'} · ${hidden ? '已隐藏' : '可见'}`;
  visibilityButton.innerHTML = hidden ? '<span>◉</span> 显示构件' : '<span>◉</span> 隐藏构件';
  rebuildComponentList(); toastMessage(hidden ? '构件已隐藏，可在列表中恢复' : '构件已显示');
});
restoreButton.addEventListener('click', () => { if (!selected) return; restoreObject(selected); selectObject(selected); toastMessage('已恢复构件默认状态'); });
modelFile.addEventListener('change', () => {
  const file = modelFile.files?.[0]; if (!file) return;
  const url = URL.createObjectURL(file); loading.classList.remove('hidden'); loading.textContent = `正在加载 ${file.name}…`;
  new GLTFLoader().load(url, gltf => {
    registerRoot(gltf.scene, file.name); URL.revokeObjectURL(url); toastMessage('模型加载成功');
  }, undefined, error => {
    console.error(error); loading.classList.add('hidden'); toastMessage('模型加载失败，请检查文件格式或浏览器控制台'); URL.revokeObjectURL(url);
  });
  modelFile.value = '';
});
window.addEventListener('resize', onResize);
registerRoot(createDemoBuilding(), '程序生成示例建筑 · 可替换为 GLB');
onResize();
function animate() { requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera); }
animate();
