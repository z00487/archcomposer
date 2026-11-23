/**
 * L1 基础设施 · 序列化与 schemaVersion 迁移
 *
 * 依据：《项目概要设计文档》§5.6（`Storyboard.schemaVersion`）、§7.1（`core/serialize.ts`）。
 */

/** 当前分镜文件格式版本。改动 Storyboard 的字段结构时必须 +1 并在下方加迁移。 */
export const STORYBOARD_SCHEMA_VERSION = 1;

export interface MigrationIssue {
  fromVersion: number;
  toVersion: number;
  note: string;
}

export interface MigrationReport {
  /** 迁移后的数据 */
  data: unknown;
  /** 实际执行的迁移步骤 */
  applied: MigrationIssue[];
  /** 无法自动迁移、需要人工处理的问题 */
  problems: string[];
}

/** 单步迁移：把版本 n 的数据变成版本 n+1。 */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * 迁移表。键是**源版本**，值是「把该版本升到下一版本」的函数。
 *
 * 现在是空的（只有 v1，还没有历史版本）。保留结构与测试，是为了让「加迁移」
 * 这件事在需要时**只是一个数组元素**，而不是一次重构——这是 NFR-8 与 FR-10
 * 的隐含要求：存下来的文件必须长期可读。
 */
export const MIGRATIONS: Record<number, Migration> = {};

export function readSchemaVersion(data: unknown): number {
  if (typeof data !== 'object' || data === null) return 0;
  const v = (data as Record<string, unknown>).schemaVersion;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * 把任意版本的分镜数据迁到当前版本。
 *
 * **诚实性原则**（任务一 §8 的 R5「存档不兼容」）：宁可明确报错，也不静默产出
 * 一个字段错位的对象——后者会让用户以为「打开成功了」，实际数据已经损坏。
 * 因此：
 *  - 版本比当前**高** → 记为 problem，不尝试降级；
 *  - 版本比当前**低但无迁移路径** → 记为 problem；
 *  - 缺失 `schemaVersion`（= 0）→ 只有当它是第一个版本且结构相符时才接受。
 */
export function migrateToCurrent(raw: unknown): MigrationReport {
  const applied: MigrationIssue[] = [];
  const problems: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { data: raw, applied, problems: ['不是一个 JSON 对象'] };
  }

  let data = raw as Record<string, unknown>;
  let version = readSchemaVersion(data);

  if (version === 0) {
    problems.push(
      '文件缺少 schemaVersion 字段，无法确定它属于哪个版本；已按 v1 结构尝试读取，但字段是否正确无法保证',
    );
    version = 1;
    data = { ...data, schemaVersion: 1 };
  }

  if (version > STORYBOARD_SCHEMA_VERSION) {
    problems.push(
      `文件版本 v${version} 高于本程序支持的 v${STORYBOARD_SCHEMA_VERSION}，请升级程序后再打开（不尝试降级，以免丢失字段）`,
    );
    return { data, applied, problems };
  }

  while (version < STORYBOARD_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) {
      problems.push(`缺少 v${version} → v${version + 1} 的迁移路径`);
      break;
    }
    data = migrate(data);
    data = { ...data, schemaVersion: version + 1 };
    applied.push({ fromVersion: version, toVersion: version + 1, note: '自动迁移' });
    version += 1;
  }

  return { data, applied, problems };
}

/** 稳定化 JSON 输出：键顺序固定为传入顺序，缩进 2 空格，末尾留一个换行。 */
export function stableStringify(value: unknown, indent = 2): string {
  return `${JSON.stringify(value, null, indent)}\n`;
}
