/**
 * L4 应用层 · 大模型设置的本地持久化
 *
 * **为什么单独一个文件**：这是「设置」这条数据流的唯一出入口。把读写都收在这里，
 * 就能一眼看清**什么东西被写到了哪**——这对一份要答辩的工程很重要，因为
 * 「API key 有没有被持久化、持久化到哪」是评委最可能追问的问题之一。
 *
 * **key 只进浏览器本地存储，绝不入仓库**：
 *  - 代码里没有任何默认 key（`DEFAULT_LLM_SETTINGS.apiKey` 是空串）；
 *  - 落盘位置是 `localStorage` 的一个键，随浏览器配置走，不进 git；
 *  - 真正的推荐路径是**根本不填**——key 留在服务端环境变量里（见 `.env.example`
 *    与 `scripts/llm-proxy.mjs`）。
 *
 * **读的时候必须容错**：本地存储是用户可以手改的，也可能是旧版本写下的形状。
 * 任何一项不合法就退回默认值，而不是让整个应用在启动时抛异常。
 */
import { DEFAULT_LLM_SETTINGS, type LlmSettings } from './client.ts';

/** 本地存储的键名。带版本号，将来形状变了可以直接换键、旧数据自然失效。 */
export const LLM_SETTINGS_KEY = 'archcomposer.llm.v1';

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 把任意输入规整成合法的 `LlmSettings`。 */
export function normalizeLlmSettings(value: unknown): LlmSettings {
  const raw = (value ?? {}) as Partial<Record<keyof LlmSettings, unknown>>;
  return {
    endpoint: typeof raw.endpoint === 'string' && raw.endpoint.trim() ? raw.endpoint.trim() : DEFAULT_LLM_SETTINGS.endpoint,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_LLM_SETTINGS.model,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
    temperature: clampNumber(raw.temperature, DEFAULT_LLM_SETTINGS.temperature, 0, 1.5),
    timeoutMs: clampNumber(raw.timeoutMs, DEFAULT_LLM_SETTINGS.timeoutMs, 5000, 300000),
  };
}

/**
 * 从本地存储读设置。
 *
 * `storage` 可注入（默认 `localStorage`），这样 Node 端的单测可以喂一个假对象，
 * 不需要 happy-dom。
 */
export function loadLlmSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LlmSettings {
  if (!storage) return { ...DEFAULT_LLM_SETTINGS };
  try {
    const text = storage.getItem(LLM_SETTINGS_KEY);
    if (!text) return { ...DEFAULT_LLM_SETTINGS };
    return normalizeLlmSettings(JSON.parse(text));
  } catch {
    // 存的是坏 JSON（用户手改过、或上个版本写坏了）→ 静默退回默认值。
    // 这里**不抛异常也不提示**：启动时弹一条「设置读取失败」对作者毫无用处，
    // 因为他改的东西本来是可以重新填的。
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

/** 保存设置。写失败（隐私模式、配额满）时返回 false，让调用方能提示一句。 */
export function saveLlmSettings(
  settings: LlmSettings,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LLM_SETTINGS_KEY, JSON.stringify(normalizeLlmSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

/** 取本地存储，取不到（Node 环境 / 隐私模式禁用了存储）就返回 null。 */
function safeStorage(): Storage | null {
  try {
    // 直接读 `localStorage` 在部分隐私模式下会抛 SecurityError，因此要包一层
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
