/**
 * 自然语言编辑指令与反馈归因的单元测试（开题报告 §3.3、§3.6）
 *
 * **这批测试的价值在于「用作者真的会说的话去试」**：注释里的例句全部照抄
 * 开题报告 §3.3 与 §3.6 的原文（「把斗拱放到第二步介绍」「不要把柱子隐藏掉，
 * 要保留整体结构作为参照」「这个视角看不清斗拱」「柱子应该一直保留」
 * 「镜头切换太快」），而不是我自己造的好例子。这样测试通过就意味着
 * **开题报告里承诺的那几句话真的能听懂**。
 */
import { describe, expect, it } from 'vitest';

import {
  parseEditInstruction,
  extractDurationMs,
  extractMotionDegrees,
  matchKinds,
  matchLocators,
  resolveComponents,
  findStepIndexByTarget,
  MIN_COMMAND_CONFIDENCE,
} from '../domain/language/instructions.ts';
import type { ParseContext } from '../domain/language/instructions.ts';
import { diagnoseFeedback, FeedbackAspect } from '../domain/language/feedback.ts';
import { extractOrdinal, parseChineseNumber, toChineseNumber, toHalfWidth } from '../domain/language/chinese.ts';
import { createStep, createStoryboard } from '../domain/types/storyboard.ts';
import { addStep } from '../domain/storyboard/storyboard.ts';
import type { Storyboard } from '../domain/types/storyboard.ts';
import { singleTarget, testScene } from './fixtures.ts';

// ── 中文数字与序号 ─────────────────────────────────────────────

describe('中文数字解析', () => {
  it('阿拉伯数字原样返回', () => {
    expect(parseChineseNumber('2')).toBe(2);
    expect(parseChineseNumber('12')).toBe(12);
  });

  it('个位中文数字', () => {
    expect(parseChineseNumber('三')).toBe(3);
    expect(parseChineseNumber('九')).toBe(9);
  });

  it('「两」当作 2（口语里常这么写）', () => {
    expect(parseChineseNumber('两')).toBe(2);
  });

  it('十一 / 二十 / 二十三', () => {
    expect(parseChineseNumber('十一')).toBe(11);
    expect(parseChineseNumber('二十')).toBe(20);
    expect(parseChineseNumber('二十三')).toBe(23);
  });

  it('认不出来返回 null，而不是猜一个数', () => {
    expect(parseChineseNumber('斗拱')).toBeNull();
    expect(parseChineseNumber('')).toBeNull();
  });

  it('全角数字转半角', () => {
    expect(toHalfWidth('第２步')).toBe('第2步');
    expect(toHalfWidth('，：。')).toBe(',:.');
  });

  it('extractOrdinal 认「第二步」「第 2 步」「2 步」', () => {
    expect(extractOrdinal('把斗拱放到第二步')).toBe(2);
    expect(extractOrdinal('第 3 步讲得太复杂')).toBe(3);
    expect(extractOrdinal('第12段')).toBe(12);
    expect(extractOrdinal('这一步的旁白改成别的')).toBeNull();
  });

  it('toChineseNumber 回读一致', () => {
    for (const n of [1, 2, 3, 9, 10, 11, 20, 23]) {
      expect(parseChineseNumber(toChineseNumber(n))).toBe(n);
    }
  });
});

// ── 语义匹配 ───────────────────────────────────────────────────

describe('构件类型与方位的语义匹配', () => {
  it('认出古建术语', () => {
    expect(matchKinds('把斗拱放到第二步')).toContain('dougong');
    expect(matchKinds('不要隐藏柱子')).toContain('column');
    expect(matchKinds('屋顶和檩条')).toEqual(expect.arrayContaining(['roof', 'purlin']));
  });

  it('认出方位限定', () => {
    expect(matchLocators('东侧的柱子').sides).toContain('e');
    expect(matchLocators('后檐的椽').eaves).toContain('back');
  });

  it('★ 从真实场景里解析出构件：无限定时收全类', () => {
    const scene = testScene();
    const ids = resolveComponents(['column'], { sides: [], eaves: [] }, scene);
    expect(ids).toEqual(['hall@1/column_c__01']);
  });

  it('方位限定过滤掉不符的构件', () => {
    const scene = testScene();
    // 夹具里的 column_c__01 站位是 'c'，说「东侧」就应当一个都匹配不上
    const ids = resolveComponents(['column'], { sides: ['e'], eaves: [] }, scene);
    expect(ids).toEqual([]);
  });

  it('场景为空时返回空数组（不抛错）', () => {
    expect(resolveComponents(['column'], { sides: [], eaves: [] }, null)).toEqual([]);
  });

  it('类型没命中时返回空数组（宁可不改，也不猜）', () => {
    expect(resolveComponents(['xyz'], { sides: [], eaves: [] }, testScene())).toEqual([]);
  });
});

// ── 时长与运镜的数值抽取 ───────────────────────────────────────

describe('数值抽取', () => {
  it('抽时长：3 秒 → 3000ms，800ms → 800ms', () => {
    expect(extractDurationMs('停 3 秒')).toBe(3000);
    expect(extractDurationMs('时长改成 2.5 秒')).toBe(2500);
    expect(extractDurationMs('800毫秒')).toBe(800);
    expect(extractDurationMs('没有数字')).toBeNull();
  });

  it('抽环绕角度：一圈 → 360，半圈 → 180，90 度 → 90', () => {
    expect(extractMotionDegrees('绕建筑转一圈')).toBe(360);
    expect(extractMotionDegrees('环绕半圈')).toBe(180);
    expect(extractMotionDegrees('转 90 度')).toBe(90);
    expect(extractMotionDegrees('就停在这')).toBeNull();
  });
});

// ── ★ 开题报告 §3.3 的原文例句 ─────────────────────────────────

describe('★ 开题报告 §3.3 的原话能不能听懂', () => {
  /** 三段式分镜：第1步讲整体、第2步讲柱子、第3步讲斗拱。 */
  function ctx(): ParseContext {
    const scene = testScene();
    let sb: Storyboard = createStoryboard('测试分镜');
    sb = addStep(sb, createStep(singleTarget('hall@1/roof_front', 'roof'), '讲整体'));
    sb = addStep(sb, createStep(singleTarget('hall@1/column_c__01', 'column'), '讲柱子'));
    sb = addStep(sb, createStep(singleTarget('hall@1/beam_c__01', 'beam'), '讲梁'));
    return {
      scene,
      storyboard: sb,
      activeStepId: sb.steps[1].id,
      labelOf: (id) => id,
    };
  }

  it('「把斗拱放到第二步介绍」→ 识别为「调整顺序」', () => {
    // 夹具里没有斗拱，因此源构件找不到 → 置信度降低但不为零
    const result = parseEditInstruction('把斗拱放到第二步介绍', ctx());
    expect(result.recognized).toBe(true);
    expect(result.commands[0].kind).toBe('move-step');
    expect(result.commands[0].stepIndex).toBe(2);
  });

  it('★「把柱子放到第三步」→ 找到「讲柱子」那一步作为源', () => {
    const result = parseEditInstruction('把柱子放到第三步', ctx());
    const cmd = result.commands[0];
    expect(cmd.kind).toBe('move-step');
    expect(cmd.stepIndex).toBe(3); // 目标位置
    expect(cmd.payload?.sourceStepIndex).toBe(2); // 源 = 第 2 步（它在讲柱子）
  });

  it('「不要隐藏柱子」→ 识别为「保留」，不是「隐藏」', () => {
    const result = parseEditInstruction('不要把柱子隐藏掉', ctx());
    expect(result.recognized).toBe(true);
    expect(result.commands[0].kind).toBe('keep-components');
    expect(result.commands[0].componentIds).toContain('hall@1/column_c__01');
  });

  it('「要保留整体结构作为参照」→ 保留', () => {
    const result = parseEditInstruction('要保留整体结构作为参照', ctx());
    expect(result.commands[0].kind).toBe('keep-components');
  });

  it('「这里重点讲一下斗拱和屋檐的支撑关系」→ 揭示关系（有「关系」「支撑」）', () => {
    const result = parseEditInstruction('这里重点讲一下斗拱和屋檐的支撑关系', ctx());
    expect(result.recognized).toBe(true);
    expect(result.commands[0].kind).toBe('set-intent');
    expect(result.commands[0].payload?.intentKind).toBe('REVEAL_RELATION');
  });

  it('「这一句的旁白改成从侧面看斗拱」→ 改旁白，且旁白正文被正确截出', () => {
    const result = parseEditInstruction('这一句的旁白改成从侧面看斗拱', ctx());
    expect(result.commands[0].kind).toBe('set-narration');
    expect(result.commands[0].payload?.narration).toContain('从侧面看斗拱');
  });

  it('「删掉第四步」——越界序号仍能解析（执行时才报越界）', () => {
    const result = parseEditInstruction('删掉第四步', ctx());
    expect(result.commands[0].kind).toBe('delete-step');
    expect(result.commands[0].stepIndex).toBe(4);
  });

  it('「让这一步环绕一圈」→ 运镜 360°', () => {
    const result = parseEditInstruction('让这一步环绕一圈', ctx());
    expect(result.commands[0].kind).toBe('set-motion');
    expect(result.commands[0].payload?.degrees).toBe(360);
  });

  it('★ 一句话里说两件事 → 两条指令都出来', () => {
    const result = parseEditInstruction('把柱子放到第三步，并且不要隐藏斗拱', ctx());
    expect(result.commands.length).toBeGreaterThanOrEqual(2);
    const kinds = result.commands.map((c) => c.kind);
    expect(kinds).toContain('move-step');
    expect(kinds).toContain('keep-components');
  });

  it('★ 听不懂就说听不懂，不硬猜', () => {
    const result = parseEditInstruction('嗯那个什么来着要不还是算了吧', ctx());
    expect(result.recognized).toBe(false);
    expect(result.commands).toEqual([]);
  });

  it('空输入不产生任何指令', () => {
    expect(parseEditInstruction('   ', ctx()).commands).toEqual([]);
  });

  it('每条指令都带 rationale，界面能解释「我是这么理解的」', () => {
    const result = parseEditInstruction('删掉第二步', ctx());
    expect(result.commands[0].rationale.length).toBeGreaterThan(0);
  });

  it('★ 置信度阈值：低于阈值的指令不会混在结果里', () => {
    const result = parseEditInstruction('删掉第二步', ctx());
    for (const c of result.commands) expect(c.confidence).toBeGreaterThanOrEqual(MIN_COMMAND_CONFIDENCE);
  });
});

// ── 反向查找：从构件找步骤 ─────────────────────────────────────

describe('从构件反查是哪一步在讲它', () => {
  it('命中返回 1 起序号，未命中返回 null', () => {
    let sb: Storyboard = createStoryboard('s');
    sb = addStep(sb, createStep(singleTarget('hall@1/column_c__01', 'column'), '柱子'));
    expect(findStepIndexByTarget(sb, ['hall@1/column_c__01'])).toBe(1);
    expect(findStepIndexByTarget(sb, ['hall@1/beam_c__01'])).toBeNull();
    expect(findStepIndexByTarget(sb, [])).toBeNull();
  });
});

// ── ★ 开题报告 §3.6 的反馈归因 ─────────────────────────────────

describe('★ 反馈归因（开题报告 §3.6）', () => {
  function ctx() {
    const scene = testScene();
    let sb: Storyboard = createStoryboard('测试分镜');
    sb = addStep(sb, createStep(singleTarget('hall@1/column_c__01', 'column'), '讲柱子'));
    sb = addStep(sb, createStep(singleTarget('hall@1/beam_c__01', 'beam'), '讲梁'));
    return { scene, storyboard: sb, activeStepId: sb.steps[0].id };
  }

  it('★「这个视角看不清斗拱」→ 归因到「视点」', () => {
    const result = diagnoseFeedback('这个视角看不清斗拱', ctx());
    expect(result.recognized).toBe(true);
    expect(result.diagnoses[0].aspect).toBe(FeedbackAspect.Viewpoint);
  });

  it('★ 归因到视点时建议「重解」而不是瞎猜一个机位', () => {
    const result = diagnoseFeedback('这个视角看不清', ctx());
    expect(result.diagnoses[0].suggested?.kind).toBe('re-solve');
  });

  it('★「柱子应该一直保留」→ 归因到「视觉效果」', () => {
    const result = diagnoseFeedback('柱子应该一直保留', ctx());
    expect(result.diagnoses[0].aspect).toBe(FeedbackAspect.Effects);
    expect(result.diagnoses[0].suggested?.kind).toBe('keep-components');
    expect(result.diagnoses[0].suggested?.componentIds).toContain('hall@1/column_c__01');
  });

  it('★「镜头切换太快」→ 归因到「节奏」，且给一个可确认的建议值', () => {
    const result = diagnoseFeedback('镜头切换太快', ctx());
    expect(result.diagnoses[0].aspect).toBe(FeedbackAspect.Pacing);
    const ms = result.diagnoses[0].suggested?.payload?.durationMs as number;
    expect(ms).toBeGreaterThan(4000); // 默认 4000 → 放慢到 6400
    expect(result.diagnoses[0].suggested?.confidence).toBeLessThanOrEqual(0.65); // 系统建议，不装作确定
  });

  it('给了具体时长时按具体值来，不给建议值', () => {
    const result = diagnoseFeedback('这一步停 8 秒', ctx());
    expect(result.diagnoses[0].suggested?.payload?.durationMs).toBe(8000);
  });

  it('★「这一段讲得太复杂」→ 归因到「讲解内容」', () => {
    const result = diagnoseFeedback('这一段讲得太复杂', ctx());
    expect(result.diagnoses[0].aspect).toBe(FeedbackAspect.Content);
  });

  it('★ 归因到内容时不给「代笔」动作（系统不擅自改文字）', () => {
    const result = diagnoseFeedback('这一段讲得太复杂', ctx());
    expect(result.diagnoses[0].suggested).toBeNull();
  });

  it('「讲错对象了，应该是斗拱」→ 归因到「目标构件」', () => {
    const result = diagnoseFeedback('讲错对象了，应该是斗拱', ctx());
    expect(result.diagnoses[0].aspect).toBe(FeedbackAspect.Target);
  });

  it('★ 一句反馈里两件事 → 两条归因', () => {
    const result = diagnoseFeedback('这个视角看不清，而且柱子别隐藏', ctx());
    expect(result.diagnoses.length).toBeGreaterThanOrEqual(2);
    const aspects = result.diagnoses.map((d) => d.aspect);
    expect(aspects).toContain(FeedbackAspect.Viewpoint);
    expect(aspects).toContain(FeedbackAspect.Effects);
  });

  it('★ 归因不到就说归因不到', () => {
    const result = diagnoseFeedback('嗯挺好的', ctx());
    expect(result.recognized).toBe(false);
    expect(result.diagnoses).toEqual([]);
  });

  it('带序号时归因到那一步', () => {
    const result = diagnoseFeedback('第二步看不清', ctx());
    expect(result.diagnoses[0].stepIndex).toBe(2);
  });

  it('每条归因都带 rationale', () => {
    const result = diagnoseFeedback('这个视角看不清', ctx());
    expect(result.diagnoses[0].rationale.length).toBeGreaterThan(0);
  });
});
