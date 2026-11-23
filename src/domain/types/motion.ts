/**
 * 运镜（Camera Motion）类型 —— 步骤可选的「镜头自身运动」
 *
 * 依据：开题报告 §3.5「自动镜头编排」与开题答辩 PPT 第 9 页的镜头示例
 * 「01 全景环绕 · 360°」。
 *
 * **为什么需要它，而 `camera` 一个字段不够**：`camera` 描述的是这一步**停在哪**，
 * 是一个静态位姿。但讲解里有一类镜头是**动的**——绕建筑转一圈、从远处推近。
 * 这类镜头在原有的数据模型里无处表达：把它拆成若干个静态步骤既啰嗦，又会在
 * 语义上把「一次环绕」误读成「六次机位变化」。
 *
 * **设计上的克制**：本字段只描述「相对起始机位做什么运动」，不描述绝对轨迹。
 * 因此 `camera` 仍然是这一步的锚点（也是重定向时被重解的那个量），运镜只是在
 * 锚点上叠加的一个相对运动。这样**重定向与运镜不冲突**：换目标后 `camera` 重解，
 * 环绕仍然是「绕新目标转一圈」。
 */
import type { Vec3 } from './geometry.ts';

export const MotionKind = {
  /** 环绕：绕一个枢轴在水平面内旋转 */
  Orbit: 'orbit',
} as const;
export type MotionKind = (typeof MotionKind)[keyof typeof MotionKind];

export const MOTION_KIND_LABELS: Record<MotionKind, string> = {
  orbit: '环绕',
};

export interface CameraMotion {
  kind: MotionKind;
  /**
   * 环绕角度（度）。正数 = 俯视时顺时针（从东侧往南侧走），负数 = 逆时针。
   * 常用值：360（全景环绕一周）、180（半周，展示两个立面）、-90（转到侧面）。
   */
  degrees: number;
  /**
   * 枢轴（世界坐标）。`null` 表示用**步骤目标的包围盒中心**——这是常见情形，
   * 也是重定向后仍然正确的选择（换目标后枢轴自动跟着换）。
   */
  pivot: Vec3 | null;
}

/** 运镜的用户可读描述，如「环绕一周（360°）」。 */
export function describeMotion(motion: CameraMotion): string {
  const deg = Math.round(motion.degrees);
  if (Math.abs(deg) === 360) return '环绕一周（360°）';
  if (Math.abs(deg) === 180) return '环绕半周（180°）';
  if (deg === 90) return '向右环绕 90°';
  if (deg === -90) return '向左环绕 90°';
  return `环绕 ${deg}°`;
}

/** 预设：UI 下拉框的选项。 */
export const MOTION_PRESETS: Array<{ degrees: number; label: string }> = [
  { degrees: 360, label: '全景环绕一周 · 360°' },
  { degrees: 180, label: '环绕半周 · 180°' },
  { degrees: 90, label: '向右环绕 90°' },
  { degrees: -180, label: '反向环绕半周 · -180°' },
];

/** 构造一个环绕运镜。 */
export function orbitMotion(degrees: number, pivot: Vec3 | null = null): CameraMotion {
  return { kind: MotionKind.Orbit, degrees, pivot };
}
