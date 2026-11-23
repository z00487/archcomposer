/**
 * M13 存取（`.storyboard.json`）的单元测试
 *
 * **本文件的重点是「存档的诚实性」**（任务一 §8 的 R5「存档不兼容」）：
 * 宁可明确报错，也不静默产出一个字段错位的对象——后者会让用户以为
 * 「打开成功了」，实际数据已经损坏。
 */
import { describe, it, expect } from 'vitest';
import { serializeStoryboard, parseStoryboard } from '../app/io/io.ts';
import { migrateToCurrent, stableStringify, readSchemaVersion, STORYBOARD_SCHEMA_VERSION } from '../core/serialize.ts';
import { addStep, retargetStep, findStep } from '../domain/storyboard/storyboard.ts';
import { createStep, createStoryboard } from '../domain/types/storyboard.ts';
import { IntentKind, defaultPredicatesFor } from '../domain/types/intent.ts';
import { singleTarget, poseLookingNorth } from './fixtures.ts';
import { resetIdCounter } from '../core/id.ts';

function sampleBoard() {
  resetIdCounter();
  let board = createStoryboard('入口厅堂讲解');
  board = addStep(
    board,
    {
      ...createStep(singleTarget('demohall@1/column_e__01', 'column'), '讲东侧柱'),
      intent: {
        id: 'i1',
        kind: IntentKind.Emphasize,
        predicates: defaultPredicatesFor(IntentKind.Emphasize),
        provenance: { source: 'demo', confidence: 0.8, rationale: '演示时拉近了相机', confirmedByUser: true },
      },
      camera: poseLookingNorth(4, 2),
      solve: 'solved',
      solveNote: '已求解，保真度 91%',
    },
  );
  return board;
}

describe('序列化', () => {
  it('输出带 schemaVersion 与 updatedAt', () => {
    const text = serializeStoryboard(sampleBoard());
    const parsed = JSON.parse(text);
    expect(parsed.schemaVersion).toBe(STORYBOARD_SCHEMA_VERSION);
    expect(parsed.meta.updatedAt).toBeTruthy();
  });

  it('输出是缩进的可读 JSON（NFR-8：人能读、也能手改）', () => {
    const text = serializeStoryboard(sampleBoard());
    expect(text).toContain('\n  ');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('★ 不存任何运行时信息（无 three 对象、无对象引用）', () => {
    const text = serializeStoryboard(sampleBoard());
    // 序列化结果里不应出现 three 的内部字段名
    expect(text).not.toContain('uuid');
    expect(text).not.toContain('Object3D');
    expect(text).not.toContain('mesh');
    // 也不应出现 [object Object] 这类循环引用残留
    expect(text).not.toContain('[object');
  });

  it('稳定输出：同一分镜两次序列化除时间戳外一致', () => {
    const a = serializeStoryboard(sampleBoard()).replace(/"updatedAt":"[^"]+"/, '');
    const b = serializeStoryboard(sampleBoard()).replace(/"updatedAt":"[^"]+"/, '');
    expect(a).toBe(b);
  });
});

describe('★ 往返（round-trip）', () => {
  it('序列化 → 反序列化后，步骤的每一个字段都还在', () => {
    const board = sampleBoard();
    const result = parseStoryboard(serializeStoryboard(board));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    const restored = result.storyboard!;
    expect(restored.steps.length).toBe(1);

    const step = restored.steps[0];
    const original = board.steps[0];
    expect(step.id).toBe(original.id);
    expect(step.title).toBe(original.title);
    expect(step.target).toEqual(original.target);
    expect(step.intent).toEqual(original.intent);
    expect(step.camera).toEqual(original.camera);
    expect(step.durationMs).toBe(original.durationMs);
    expect(step.transition).toBe(original.transition);
    expect(step.solve).toBe('solved');
    expect(step.solveNote).toBe(original.solveNote);
  });

  it('★ 意图的谓词与来源留痕完整保留（论文要区分「系统推断的」与「用户确认的」）', () => {
    const result = parseStoryboard(serializeStoryboard(sampleBoard()));
    const intent = result.storyboard!.steps[0].intent!;
    expect(intent.kind).toBe(IntentKind.Emphasize);
    expect(intent.provenance.confirmedByUser).toBe(true);
    expect(intent.provenance.source).toBe('demo');
    expect(intent.provenance.rationale).toBeTruthy();
    expect(intent.predicates.length).toBeGreaterThan(0);
  });

  it('★ stale 状态能被完整存下来（「待重算」这件事不会在存档中丢失）', () => {
    const board = sampleBoard();
    const retargeted = retargetStep(board, board.steps[0].id, singleTarget('demohall@1/column_w__01', 'column'));
    const result = parseStoryboard(serializeStoryboard(retargeted));

    expect(result.ok).toBe(true);
    const step = findStep(result.storyboard!, board.steps[0].id)!;
    expect(step.solve).toBe('stale');
    // 旧机位仍在（它是重解的种子）
    expect(step.camera).toEqual(poseLookingNorth(4, 2));
    // 意图没变
    expect(step.intent!.id).toBe('i1');
  });

  it('空分镜能往返（只有警告，没有错误）', () => {
    const result = parseStoryboard(serializeStoryboard(createStoryboard('空的')));
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.storyboard!.title).toBe('空的');
  });
});

describe('★ 错误处理：宁可明确报错，也不静默产出错位数据', () => {
  it('非 JSON 文本 → 明确报错', () => {
    const result = parseStoryboard('这不是 JSON');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('JSON');
    expect(result.storyboard).toBeNull();
  });

  it('合法 JSON 但不是对象 → 报错', () => {
    expect(parseStoryboard('42').ok).toBe(false);
    expect(parseStoryboard('"字符串"').ok).toBe(false);
  });

  it('缺少 steps 数组 → 报错并指出「可能不是分镜文件」', () => {
    const result = parseStoryboard(JSON.stringify({ id: 'x', title: 'y', schemaVersion: 1 }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('steps'))).toBe(true);
  });

  it('★ 缺 schemaVersion → 记为警告（而不是假装一切正常）', () => {
    const legacy = JSON.stringify({ id: 'x', title: 'y', steps: [] });
    const result = parseStoryboard(legacy);
    expect(result.warnings.some((w) => w.includes('schemaVersion'))).toBe(true);
  });

  it('★ 版本高于当前 → 记为警告且不尝试降级', () => {
    const future = JSON.stringify({ id: 'x', title: 'y', steps: [], schemaVersion: 99 });
    const result = parseStoryboard(future);
    expect(result.warnings.some((w) => w.includes('高于'))).toBe(true);
  });

  it('步骤缺 target 时**跳过该步骤**并报错，而不是编一个假目标', () => {
    const broken = JSON.stringify({
      id: 'x',
      title: 'y',
      schemaVersion: 1,
      steps: [
        { id: 'a', title: '坏步骤' }, // 没有 target
        {
          id: 'b',
          title: '好步骤',
          target: singleTarget('demohall@1/column_e__01', 'column'),
        },
      ],
    });
    const result = parseStoryboard(broken);
    expect(result.errors.some((e) => e.includes('损坏'))).toBe(true);
    // 好步骤被保留了下来
    expect(result.storyboard!.steps.length).toBe(1);
    expect(result.storyboard!.steps[0].title).toBe('好步骤');
  });

  it('可选字段缺失时用默认值补齐（宽容），但关键字段缺失不补', () => {
    const minimal = JSON.stringify({
      id: 'x',
      title: 'y',
      schemaVersion: 1,
      steps: [{ id: 'a', title: '步骤', target: singleTarget('c') }],
    });
    const result = parseStoryboard(minimal);
    const step = result.storyboard!.steps[0];
    expect(step.durationMs).toBe(4000); // 默认时长
    expect(step.transition).toBe('smooth'); // 默认转场
    expect(step.effects).toEqual({ highlight: [], transparent: [], hidden: [] });
    expect(step.narration).toBe('');
  });

  it('非法的 solve 值被归一化为 none（而不是让一个坏值流进系统）', () => {
    const bad = JSON.stringify({
      id: 'x',
      title: 'y',
      schemaVersion: 1,
      steps: [{ id: 'a', title: 's', target: singleTarget('c'), solve: '随便写的' }],
    });
    const result = parseStoryboard(bad);
    expect(result.storyboard!.steps[0].solve).toBe('none');
  });
});

describe('迁移器 (core/serialize)', () => {
  it('readSchemaVersion 对缺失/非法值返回 0', () => {
    expect(readSchemaVersion({})).toBe(0);
    expect(readSchemaVersion(null)).toBe(0);
    expect(readSchemaVersion({ schemaVersion: 'x' })).toBe(0);
    expect(readSchemaVersion({ schemaVersion: 2 })).toBe(2);
  });

  it('当前版本的数据原样通过', () => {
    const report = migrateToCurrent({ schemaVersion: STORYBOARD_SCHEMA_VERSION, steps: [] });
    expect(report.applied).toEqual([]);
    expect(report.problems).toEqual([]);
  });

  it('无迁移路径的低版本 → 记为 problem（而不是默默放过）', () => {
    const report = migrateToCurrent({ schemaVersion: 0.5, steps: [] });
    expect(report.problems.length).toBeGreaterThan(0);
  });

  it('stableStringify 结尾带换行、缩进 2 空格', () => {
    const text = stableStringify({ a: 1 });
    expect(text).toBe('{\n  "a": 1\n}\n');
  });
});
