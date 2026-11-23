/**
 * L2 运行时 · M5 示范录制（FR-11）
 *
 * 依据：《项目概要设计文档》§4.1 的 M5、§5.7、§3.3（「L2 负责示范录制（捕获操作）」）。
 *
 * **两条与概要设计正文略有出入、需要说明的实现决定**（已记入任务三文档的偏差表）：
 *
 * 1. **归约（actions → DemoOutcome）放在 L2**，而不是 L3 的 M7。理由：只有 L2
 *    知道 THREE 对象当前的透明度与可见性。若放在 L3，L3 就得反过来持有场景
 *    对象引用，直接违反约束 C-1。
 *
 * 2. **相机轨迹做了抽稀**。作者的相机操作每秒可能有几十次（OrbitControls 的
 *    damping 每帧都在改位姿），逐帧记录会让文件体积失控且绝大多数帧没有信息量。
 *    这里按「移动超过阈值」或「超过时间间隔」采样，仍需保留首尾——轨迹的首尾
 *    是推断「强调强度」与「视角偏好」的主要信号（§4.2.1 信号 3）。
 */
import type { ComponentId } from '../../domain/types/component.ts';
import type { DemoAction, DemoRecord, DemoOutcome } from '../../domain/types/storyboard.ts';
import type { Pose } from '../../domain/types/geometry.ts';
import { clonePose, v3distance } from '../../core/math.ts';
import { materialsOf } from '../effects/effects.ts';
import { makeId } from '../../core/id.ts';
import type { ModelRegistry } from '../model/registry.ts';

/** 相机采样的最小位移（米）。小于它视为抖动，不记。 */
export const CAMERA_MOVE_EPSILON = 0.05;
/** 相机采样的最大间隔（毫秒）。超过它即便没动也记一次，避免「长时间静止」丢失时间信息。 */
export const CAMERA_SAMPLE_INTERVAL = 700;

/**
 * 示范录制器。
 *
 * **为什么要单独一个类而不是往 Store 里塞几个数组**：录制有几个跨字段的不变量
 * （同一个构件不能同时既有 opacity 又有 visibility 记录……不，是可以的），
 * 更重要的是 `touchedIds` 的去重与顺序需要维护。这些收在一处比散在命令层清晰。
 */
export class DemoRecorder {
  private record: DemoRecord | null = null;
  private lastCameraSample: Pose | null = null;
  private lastCameraSampleAt = 0;
  private touched: ComponentId[] = [];
  private registry: ModelRegistry | null = null;

  attach(registry: ModelRegistry | null): void {
    this.registry = registry;
  }

  get recording(): boolean {
    return this.record !== null;
  }

  get actionCount(): number {
    return this.record?.actions.length ?? 0;
  }

  start(): void {
    this.record = {
      id: makeId('demo'),
      actions: [],
      startedAt: Date.now(),
      endedAt: Date.now(),
      modelPrefix: this.registry?.prefix ?? '',
    };
    this.touched = [];
    this.lastCameraSample = null;
    this.lastCameraSampleAt = 0;
  }

  /** 记录一次构件操作（选中、透明度、显隐、高亮）。 */
  private push(action: DemoAction): void {
    if (!this.record) return;
    this.record.actions.push(action);
    this.record.endedAt = Date.now();
  }

  private touch(id: ComponentId): void {
    if (!this.touched.includes(id)) this.touched.push(id);
  }

  select(id: ComponentId): void {
    this.touch(id);
    this.push({ at: Date.now(), type: 'select', componentId: id });
  }

  deselect(): void {
    this.push({ at: Date.now(), type: 'deselect' });
  }

  setOpacity(id: ComponentId, value: number): void {
    this.touch(id);
    this.push({ at: Date.now(), type: 'opacity', componentId: id, value });
  }

  setVisibility(id: ComponentId, value: boolean): void {
    this.touch(id);
    this.push({ at: Date.now(), type: 'visibility', componentId: id, value });
  }

  setHighlight(id: ComponentId, value: boolean): void {
    this.touch(id);
    this.push({ at: Date.now(), type: 'highlight', componentId: id, value });
  }

  /**
   * 记录相机位姿。**带抽稀**：位移足够大或间隔足够久才记。
   *
   * 首尾一定会被保留：`start()` 之后第一次调用必然记录（`lastCameraSample === null`），
   * 而 `stop()` 时会再补记一次当前位姿。
   */
  sampleCamera(pose: Pose, now = Date.now()): void {
    if (!this.record) return;
    const moved =
      this.lastCameraSample === null ||
      v3distance(pose.position, this.lastCameraSample.position) > CAMERA_MOVE_EPSILON;
    const elapsed = now - this.lastCameraSampleAt > CAMERA_SAMPLE_INTERVAL;
    if (!moved && !elapsed) return;
    this.lastCameraSample = clonePose(pose);
    this.lastCameraSampleAt = now;
    this.push({ at: now, type: 'camera', pose: clonePose(pose) });
  }

  /**
   * 结束录制，归约出 `DemoOutcome`。
   *
   * **归约的语义**：把「一串变化」折叠成「最终状态 + 轨迹」。这样下游的规则
   * 只需读一个对象，而不用自己重放整条序列——重放逻辑若在 L3 写一遍、在回放
   * 时再写一遍，两处必然漂移。
   */
  stop(currentPose: Pose): { record: DemoRecord; outcome: DemoOutcome } | null {
    const record = this.record;
    if (!record) return null;
    // 收尾采样：保证轨迹的最后一帧就是「作者停手时看到的画面」
    this.sampleCamera(currentPose);

    const outcome = this.reduce(record.actions, currentPose);
    this.record = null;
    return { record, outcome };
  }

  private reduce(actions: DemoAction[], currentPose: Pose): DemoOutcome {
    const opacities: Record<ComponentId, number> = {};
    const hidden = new Set<ComponentId>();
    const highlighted = new Set<ComponentId>();
    const cameraTrack: Pose[] = [];
    let selectedId: ComponentId | null = null;

    for (const action of actions) {
      switch (action.type) {
        case 'select':
          selectedId = action.componentId;
          break;
        case 'deselect':
          selectedId = null;
          break;
        case 'opacity':
          opacities[action.componentId] = action.value;
          break;
        case 'visibility':
          if (action.value) hidden.delete(action.componentId);
          else hidden.add(action.componentId);
          break;
        case 'highlight':
          if (action.value) highlighted.add(action.componentId);
          else highlighted.delete(action.componentId);
          break;
        case 'camera':
          cameraTrack.push(clonePose(action.pose));
          break;
      }
    }

    // 录制结束时若作者没有取消选中，就把「最后被操作过的构件」当作焦点——
    // 这是最常见的情形（用户点了一个构件、调了相机、然后点了「结束示范」）。
    if (selectedId === null && this.touched.length > 0) {
      selectedId = this.touched[this.touched.length - 1];
    }

    // 轨迹为空（作者完全没动相机）时补上当前位姿，让下游总有东西可读
    if (cameraTrack.length === 0) cameraTrack.push(clonePose(currentPose));

    return {
      selectedId,
      opacities,
      hidden: [...hidden],
      highlighted: [...highlighted],
      cameraTrack,
      touchedIds: [...this.touched],
    };
  }

  /** 当前录制快照（用于 UI 显示「已记录 N 步」）。 */
  snapshot(): DemoRecord | null {
    return this.record;
  }

  /**
   * 从模型当前状态补记一次「全量快照」。
   *
   * **为什么需要它**：作者可能在点「开始录制」之前就已经把某些构件调透明了。
   * 那些变化不在 actions 里，但它们在最终状态里。补记一次可以保证
   * 「录制结果 = 作者看到的画面」。
   */
  captureCurrentState(): { opacities: Array<{ id: ComponentId; value: number }>; hidden: ComponentId[]; highlighted: ComponentId[] } {
    if (!this.registry) return { opacities: [], hidden: [], highlighted: [] };
    const opacities: Array<{ id: ComponentId; value: number }> = [];
    const hidden: ComponentId[] = [];
    const highlighted: ComponentId[] = [];
    for (const c of this.registry.components) {
      const material = materialsOf(c.object)[0];
      if (material && material.opacity < 1) {
        opacities.push({ id: c.id, value: Number(material.opacity.toFixed(3)) });
      }
      if (!c.object.visible) hidden.push(c.id);
    }
    return { opacities, hidden, highlighted };
  }
}
