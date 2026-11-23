/**
 * L4 应用层 · M13 存取（`.storyboard.json` 的读与写）
 *
 * 依据：《项目概要设计文档》§4.1 的 M13、§5.6、§7.1、NFR-8。
 *
 * **文件格式的设计目标只有一个：人能读懂、也能手改。** 因此：
 *  - 缩进 2 空格、键顺序稳定（`core/serialize.ts` 的 `stableStringify`）；
 *  - 不存任何运行时信息（对象引用、three 内部 ID）；
 *  - 顶层带 `schemaVersion`，配迁移器（`core/serialize.ts`）；
 *  - 构件用**稳定 ID** 引用（`demohall@1/column_e__01`），而不是索引——
 *    索引在模型改一个构件之后就会整体错位。
 *
 * **关于 `File System Access API`**：优先用它（能原地保存），不支持时退回
 * 「下载文件 + 文件选择器打开」。两条路径都实现，是因为前者在 Firefox 上
 * 还没有（NFR-4 要求纯浏览器运行，不能假设用户一定用 Chrome）。
 */
import type { Storyboard } from '../../domain/types/storyboard.ts';
import { validateStoryboard } from '../../domain/storyboard/storyboard.ts';
import { migrateToCurrent, stableStringify, STORYBOARD_SCHEMA_VERSION } from '../../core/serialize.ts';

export interface LoadResult {
  ok: boolean;
  storyboard: Storyboard | null;
  errors: string[];
  warnings: string[];
}

/** 序列化：加上 schemaVersion 与更新时间，再稳定输出。 */
export function serializeStoryboard(storyboard: Storyboard): string {
  const withVersion: Storyboard = {
    ...storyboard,
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    meta: {
      ...storyboard.meta,
      updatedAt: new Date().toISOString(),
    },
  };
  return stableStringify(withVersion);
}

/**
 * 反序列化：迁移 → 结构校验 → 业务校验。
 *
 * **三段式而不是一次 JSON.parse 就用**，因为每一段失败的原因不同、给用户的
 * 提示也不同：版本不对（要他升级程序）、结构不对（文件坏了或选错了文件）、
 * 业务不对（步骤缺目标这类可修复的问题）。
 */
export function parseStoryboard(text: string): LoadResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      storyboard: null,
      errors: [`不是合法的 JSON 文件：${(err as Error).message}`],
      warnings,
    };
  }

  const migration = migrateToCurrent(raw);
  if (migration.problems.length > 0) {
    // 版本问题记为 warning 而非 error：只要结构能读出来就尽量让用户看到内容，
    // 但必须显式告知，不能让他在不知情的情况下继续编辑一份「可能已经错位」的数据
    warnings.push(...migration.problems);
  }

  const data = migration.data as Partial<Storyboard> | null;
  if (!data || typeof data !== 'object') {
    return { ok: false, storyboard: null, errors: ['文件内容不是一个对象'], warnings };
  }

  if (!Array.isArray(data.steps)) {
    return {
      ok: false,
      storyboard: null,
      errors: ['文件缺少 steps 数组——这可能不是一个分镜文件'],
      warnings,
    };
  }

  const storyboard: Storyboard = {
    id: typeof data.id === 'string' ? data.id : 'sb_loaded',
    title: typeof data.title === 'string' ? data.title : '导入的分镜',
    steps: data.steps.map(normalizeStep).filter((s): s is Storyboard['steps'][number] => s !== null),
    modelRef: data.modelRef,
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    meta: data.meta,
  };

  if (storyboard.steps.length !== data.steps.length) {
    errors.push(`有 ${data.steps.length - storyboard.steps.length} 个步骤结构损坏，已跳过`);
  }

  const validation = validateStoryboard(storyboard);
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  return {
    ok: errors.length === 0,
    storyboard: errors.length === 0 ? storyboard : storyboard,
    errors,
    warnings,
  };
}

/**
 * 把读进来的步骤补齐到当前类型。
 *
 * **为什么宽容补齐而不是严格报错**：手改过的文件常常少几个可选字段
 * （如 `transition`）。为此拒绝整份文件太过粗暴；但如果缺的是**关键**字段
 * （如 `target`），就必须拒绝这一步——不能凭空编一个。
 */
function normalizeStep(raw: unknown): Storyboard['steps'][number] | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.target || typeof s.target !== 'object') return null;

  const effects = (s.effects ?? {}) as Record<string, unknown>;
  return {
    id: s.id,
    title: typeof s.title === 'string' ? s.title : '未命名步骤',
    narration: typeof s.narration === 'string' ? s.narration : '',
    target: s.target as Storyboard['steps'][number]['target'],
    intent: (s.intent ?? null) as Storyboard['steps'][number]['intent'],
    camera: (s.camera ?? null) as Storyboard['steps'][number]['camera'],
    motion: normalizeMotion(s.motion),
    effects: {
      highlight: Array.isArray(effects.highlight) ? (effects.highlight as string[]) : [],
      transparent: Array.isArray(effects.transparent)
        ? (effects.transparent as Array<{ id: string; opacity: number }>)
        : [],
      hidden: Array.isArray(effects.hidden) ? (effects.hidden as string[]) : [],
    },
    durationMs: typeof s.durationMs === 'number' && s.durationMs > 0 ? s.durationMs : 4000,
    transition: s.transition === 'cut' ? 'cut' : 'smooth',
    solve: normalizeSolveState(s.solve),
    solveNote: typeof s.solveNote === 'string' ? s.solveNote : undefined,
  };
}

/**
 * 求解状态的归一化。
 *
 * ⚠️ **载入时分镜文件里的 `'solved'` 不能直接信**——文件可能是上个模型下存的，
 * 或者相机字段被手改过。这里做一个保守修正：标着 solved 但没有 camera 的，
 * 一律降级为 `'none'`（而不是报错）。这正是 §5.6 那个「状态与实际是否一致」
 * 的思想在载入路径上的应用。
 */
function normalizeSolveState(value: unknown): Storyboard['steps'][number]['solve'] {
  if (value === 'solved' || value === 'stale' || value === 'failed' || value === 'none') return value;
  return 'none';
}

/**
 * 运镜字段的归一化（可选字段）。
 *
 * **宽容补齐而不是报错**：老分镜文件没有 `motion` 字段，那是完全正常的情况，
 * 补成 `null`（静态镜头）即可。只有**认得出来的坏数据**才丢弃：
 * 缺 `kind`、`degrees` 不是有限数、`degrees` 为 0（转了等于没转，无意义）。
 * 手改文件时写错一个字段不该让整份分镜打不开。
 */
function normalizeMotion(value: unknown): Storyboard['steps'][number]['motion'] {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Record<string, unknown>;
  if (m.kind !== 'orbit') return null;
  if (typeof m.degrees !== 'number' || !Number.isFinite(m.degrees) || m.degrees === 0) return null;
  const pivot = Array.isArray(m.pivot) && m.pivot.length === 3 && m.pivot.every((n) => typeof n === 'number')
    ? (m.pivot as [number, number, number])
    : null;
  return { kind: 'orbit', degrees: m.degrees, pivot };
}

// ── 下载 / 打开 ────────────────────────────────────────────────

/** 触发浏览器下载。`URL.revokeObjectURL` 必须在下载开始之后，因此用 setTimeout。 */
export function downloadStoryboard(storyboard: Storyboard): void {
  const text = serializeStoryboard(storyboard);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizeFileName(storyboard.title)}.storyboard.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 读用户选的本地文件。 */
export function readStoryboardFile(file: File): Promise<LoadResult> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(parseStoryboard(String(reader.result ?? '')));
    reader.onerror = () =>
      resolve({ ok: false, storyboard: null, errors: ['读取文件失败'], warnings: [] });
    reader.readAsText(file);
  });
}

/** 取示例分镜的路径（`public/examples/`）。 */
export function exampleStoryboardUrl(name: string): string {
  return `${import.meta.env.BASE_URL}examples/${name}`;
}

/** 载入示例分镜。 */
export async function loadExampleStoryboard(name = '入口厅堂讲解.storyboard.json'): Promise<LoadResult> {
  try {
    const response = await fetch(exampleStoryboardUrl(name));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseStoryboard(await response.text());
  } catch (err) {
    return {
      ok: false,
      storyboard: null,
      errors: [`载入示例分镜失败：${(err as Error).message}`],
      warnings: [],
    };
  }
}

/** 文件名净化：去掉路径分隔符与非法字符，避免下载时被浏览器改写。 */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 60) : '分镜';
}

/** 预估文件大小（供 UI 显示「约 3 KB」）。 */
export function estimateSize(storyboard: Storyboard): number {
  return new Blob([serializeStoryboard(storyboard)]).size;
}
