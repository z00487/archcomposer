/**
 * L1 基础设施 · 通用 ID 生成
 *
 * 与 `domain/naming/naming.ts` 的分工要分清：
 *  - 那里是**构件 ID**（`demohall@1/column_e__01`），必须跨会话稳定（FR-3），
 *    因此由模型内容派生，不允许随机成分；
 *  - 这里是**应用实体 ID**（分镜、步骤、意图、示范记录），只需在文档内唯一。
 *
 * 因此本文件不 import 任何东西——L1 不允许有依赖。
 */

/**
 * 生成一个短 ID。
 *
 * 用 `counter + 时间戳` 而不是 `Math.random`：求解器与生成器都要求「同输入必得
 * 同输出」（可复现性，任务一 §7.1 的 E1 评估依赖它）。若 ID 带随机数，任何
 * 序列化对比测试都会随机失败。
 */
let counter = 0;

export function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36).padStart(3, '0')}`;
}

/** 测试用：把计数器复位，保证测试之间的确定性。 */
export function resetIdCounter(): void {
  counter = 0;
}

/** 校验一个字符串是否是「看起来合法」的应用实体 ID（前缀_后缀）。 */
export function isAppId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9]*_[0-9a-z]+$/.test(value);
}
