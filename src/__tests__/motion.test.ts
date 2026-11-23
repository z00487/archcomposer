/**
 * 运镜的单元测试（开题报告 §3.5、答辩 PPT 第 9 页「全景环绕 · 360°」）
 *
 * **这批测试全部跑在 Node 下，不需要浏览器**——这正是把运镜的计算放在 L1/L3
 * 而不是塞进播放器的价值：环绕过程中「相机在第 t 帧应该在哪」可以逐帧断言，
 * 而不用截图去看。
 */
import { describe, expect, it } from 'vitest';

import { orbitAroundPivot, v3distance, quatLookAt } from '../core/math.ts';
import { poseAtMotion, resolveMotionPivot, describeStepMotion } from '../domain/motion/motion.ts';
import { orbitMotion, describeMotion, MOTION_PRESETS, MotionKind } from '../domain/types/motion.ts';
import { createStep } from '../domain/types/storyboard.ts';
import type { StoryboardStep } from '../domain/types/storyboard.ts';
import type { Pose } from '../domain/types/geometry.ts';
import { singleTarget, testScene } from './fixtures.ts';

/** 站在原点正南 10 米、高 2 米，看向原点。 */
function southPose(): Pose {
  return {
    position: [0, 2, 10],
    quaternion: quatLookAt([0, -2, -10]),
    fovY: Math.PI / 4,
  };
}

function stepWithMotion(degrees: number, pivot: [number, number, number] | null = null): StoryboardStep {
  return {
    ...createStep(singleTarget('hall@1/column_c__01'), '绕柱环绕'),
    camera: southPose(),
    motion: orbitMotion(degrees, pivot),
  };
}

describe('orbitAroundPivot：环绕的几何', () => {
  const pivot: [number, number, number] = [0, 0, 0];

  it('转 0° 时位姿不变（起点就是起点）', () => {
    const p = southPose();
    const out = orbitAroundPivot(p, pivot, 0);
    expect(v3distance(out.position, p.position)).toBeLessThan(1e-9);
  });

  it('★ 转 360° 回到原位（闭环）', () => {
    const p = southPose();
    const out = orbitAroundPivot(p, pivot, Math.PI * 2);
    expect(v3distance(out.position, p.position)).toBeLessThan(1e-9);
  });

  it('★ 环绕全程到枢轴的距离不变（半径守恒）', () => {
    const p = southPose();
    const r0 = v3distance(p.position, pivot);
    for (const deg of [30, 90, 150, 210, 300]) {
      const out = orbitAroundPivot(p, pivot, (deg * Math.PI) / 180);
      expect(v3distance(out.position, pivot)).toBeCloseTo(r0, 9);
    }
  });

  it('★ 环绕全程高度不变（只在水平面内转，画面不颠簸）', () => {
    const p = southPose();
    for (const deg of [0, 45, 90, 180, 270]) {
      const out = orbitAroundPivot(p, pivot, (deg * Math.PI) / 180);
      expect(out.position[1]).toBeCloseTo(p.position[1], 12);
    }
  });

  it('★ 环绕之后仍对准枢轴（视线方向 = 枢轴 − 相机位）', () => {
    const p = southPose();
    const out = orbitAroundPivot(p, pivot, Math.PI / 3);
    // 用四元数把局部 -Z 轴转出来，应当指向枢轴
    const dir = quatLookAt([
      pivot[0] - out.position[0],
      pivot[1] - out.position[1],
      pivot[2] - out.position[2],
    ]);
    const dot =
      dir[0] * out.quaternion[0] + dir[1] * out.quaternion[1] +
      dir[2] * out.quaternion[2] + dir[3] * out.quaternion[3];
    expect(Math.abs(dot)).toBeCloseTo(1, 8);
  });

  it('转 180° 时相机跑到枢轴的正对面', () => {
    const p = southPose();
    const out = orbitAroundPivot(p, pivot, Math.PI);
    expect(out.position[0]).toBeCloseTo(0, 9);
    // 起点在 +Z，转 180° 后应在 −Z 侧
    expect(out.position[2]).toBeLessThan(0);
    expect(out.position[2]).toBeCloseTo(-10, 9);
  });

  it('绕非原点枢轴也守恒（枢轴不在原点时）', () => {
    const p = southPose();
    const offPivot: [number, number, number] = [3, 1, -2];
    const r0 = v3distance(p.position, offPivot);
    const out = orbitAroundPivot(p, offPivot, 1.1);
    expect(v3distance(out.position, offPivot)).toBeCloseTo(r0, 9);
  });
});

describe('resolveMotionPivot：枢轴的选取规则', () => {
  it('运镜自带枢轴 → 用它', () => {
    const step = stepWithMotion(360, [1, 2, 3]);
    expect(resolveMotionPivot(step.motion!, step, testScene())).toEqual([1, 2, 3]);
  });

  it('★ 没有自带枢轴 → 用步骤目标的包围盒中心', () => {
    const step = stepWithMotion(360);
    const scene = testScene();
    // 夹具里的 column_c__01 中心在 (0, 0.5, 0)
    expect(resolveMotionPivot(step.motion!, step, scene)).toEqual([0, 0.5, 0]);
  });

  it('目标是两个构件 → 用两端包围盒的并的中心', () => {
    const step: StoryboardStep = {
      ...createStep(
        {
          form: 'relation',
          from: { id: 'hall@1/columnbase_e__01', semantics: { kind: 'columnbase', part: 'e', label: '柱础' } },
          to: { id: 'hall@1/beam_c__01', semantics: { kind: 'beam', part: 'c', label: '梁' } },
          relation: 'bear',
        },
        '关系',
      ),
      motion: orbitMotion(360),
    };
    // 柱础 (5,0.1,0) 边长 0.8 → x ∈ [4.6,5.4]；梁 (0,3,0) 宽 0.4 → x ∈ [-0.2,0.2]
    // 并之后 x ∈ [-0.2,5.4] → 中心 2.6；y 并之后 ∈ [0,3.3] → 中心 1.65
    const pivot = resolveMotionPivot(step.motion!, step, testScene());
    expect(pivot[0]).toBeCloseTo(2.6, 9);
    expect(pivot[1]).toBeCloseTo(1.65, 9);
  });

  it('目标不在场景里 → 退回场景中心而不是抛错', () => {
    const step: StoryboardStep = {
      ...createStep(singleTarget('hall@1/不存在'), '幽灵'),
      motion: orbitMotion(360),
    };
    expect(() => resolveMotionPivot(step.motion!, step, testScene())).not.toThrow();
  });

  it('连场景都没有 → 退回原点，仍不抛错', () => {
    const step = stepWithMotion(360);
    expect(resolveMotionPivot(step.motion!, step, null)).toEqual([0, 0, 0]);
  });
});

describe('poseAtMotion：时间轴上的位姿', () => {
  it('无运镜 → 恒等于 step.camera（静态镜头行为完全不变）', () => {
    const step: StoryboardStep = { ...createStep(singleTarget('hall@1/column_c__01'), '静态'), camera: southPose() };
    for (const t of [0, 0.25, 0.5, 1]) {
      expect(poseAtMotion(step, testScene(), t)).toBe(step.camera);
    }
  });

  it('没有机位 → 返回 null（不是抛错，播放器会跳过）', () => {
    const step: StoryboardStep = { ...createStep(singleTarget('hall@1/column_c__01'), '无位姿'), motion: orbitMotion(360) };
    expect(poseAtMotion(step, testScene(), 0.5)).toBeNull();
  });

  it('t = 0 等于起点，t = 1 等于转完全角', () => {
    const step = stepWithMotion(360, [0, 0, 0]);
    const start = poseAtMotion(step, testScene(), 0)!;
    const end = poseAtMotion(step, testScene(), 1)!;
    expect(v3distance(start.position, southPose().position)).toBeLessThan(1e-9);
    expect(v3distance(end.position, southPose().position)).toBeLessThan(1e-9); // 360° 回到原位
  });

  it('t 越界会被夹到 [0,1]（不会转过头）', () => {
    const step = stepWithMotion(180, [0, 0, 0]);
    const under = poseAtMotion(step, testScene(), -5)!;
    const over = poseAtMotion(step, testScene(), 5)!;
    const atZero = poseAtMotion(step, testScene(), 0)!;
    const atOne = poseAtMotion(step, testScene(), 1)!;
    expect(v3distance(under.position, atZero.position)).toBeLessThan(1e-9);
    expect(v3distance(over.position, atOne.position)).toBeLessThan(1e-9);
  });

  it('★ 环绕过程中到枢轴的距离恒定（这正是「绕」而不是「飘」）', () => {
    const step = stepWithMotion(360);
    const scene = testScene();
    const pivot = resolveMotionPivot(step.motion!, step, scene);
    const r0 = v3distance(step.camera!.position, pivot);
    for (const t of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const pose = poseAtMotion(step, scene, t)!;
      expect(v3distance(pose.position, pivot)).toBeCloseTo(r0, 8);
    }
  });

  it('可复现：同一个 t 取两次，结果逐位相同', () => {
    const step = stepWithMotion(360);
    const a = poseAtMotion(step, testScene(), 0.37)!;
    const b = poseAtMotion(step, testScene(), 0.37)!;
    expect(a).toEqual(b);
  });
});

describe('运镜的描述与预设', () => {
  it('360 → 环绕一周，180 → 环绕半周', () => {
    expect(describeMotion(orbitMotion(360))).toContain('360');
    expect(describeMotion(orbitMotion(180))).toContain('180');
  });

  it('预设列表里包含 PPT 第 9 页要的「全景环绕 360°」', () => {
    expect(MOTION_PRESETS.some((p) => p.degrees === 360)).toBe(true);
  });

  it('describeStepMotion 在无运镜时返回空串', () => {
    const plain: StoryboardStep = createStep(singleTarget('hall@1/column_c__01'), '无运镜');
    expect(describeStepMotion(plain)).toBe('');
    expect(describeStepMotion(stepWithMotion(360))).toContain('360');
  });

  it('kind 常量与构造器一致', () => {
    expect(orbitMotion(90).kind).toBe(MotionKind.Orbit);
  });
});
