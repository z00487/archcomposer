/**
 * L4 应用层 · LLM 客户端（走本地代理转发）
 *
 * 依据：开题报告 §4「通过 RAG 和大语言模型生成建筑讲解内容，并利用 Structured
 * Tool Calling 将自然语言指令转换为对 Storyboard 和三维场景的具体操作」。
 *
 * **为什么要走本地代理转发，而不是浏览器直连厂商 API**（这是本轮的一个明确决策）：
 *
 *  1. **CORS**。DeepSeek 等厂商的 API 不向浏览器放行跨域请求（它们假定调用方是
 *     服务端）。浏览器直连会在预检请求就被拒，且不同厂商行为不一致，演示时
 *     极容易翻车。
 *  2. **API key 不该进浏览器**。走代理时 key 存在服务端进程的**环境变量或本地
 *     配置文件**里，浏览器只发一个同源的 `/api/llm` 请求，key 不出现在
 *     DevTools 的网络面板、本地存储或任何前端代码里。
 *  3. **可离线回归**。代理层可以在没有 key 时直接拒绝，前端据此走规则回退——
 *     于是 `npm run verify` 在没有网络的机器上也全绿。
 *
 * **代理实现在 `vite.config.ts` 的 dev 中间件里**（开发时），以及
 * `scripts/llm-proxy.mjs`（独立跑，供 preview 或纯静态部署时用）。
 *
 * **客户端这边只负责三件事**：拼请求、发请求、把失败如实翻译成中文。
 * 提示词组装与输出校验都不在这里——它们在 L3（`domain/generator/llm-generator.ts`），
 * 因为那部分是可以单测的纯逻辑。
 */
import type { Complete, CompletionRequest, CompletionResult } from '../../domain/generator/llm-generator.ts';

/** LLM 连接设置。**key 只保存在浏览器本地设置里**，不写进任何仓库文件。 */
export interface LlmSettings {
  /** 代理地址。默认同源 /api/llm（由 vite 的 dev 中间件提供） */
  endpoint: string;
  /** 模型名，如 deepseek-chat */
  model: string;
  /**
   * API key。
   *
   * ⚠️ 默认**留空**：留空时客户端请代理层用它自己的环境变量（`DEEPSEEK_API_KEY`），
   * 这是推荐做法——key 不进浏览器。只有在「没有代理、直连厂商」这种特殊情形下，
   * 才需要在这里填 key，那时它会被放在请求头里。
   */
  apiKey: string;
  /** 采样温度。生成讲解要稳，默认偏低。 */
  temperature: number;
  /** 超时（毫秒） */
  timeoutMs: number;
}

export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  endpoint: '/api/llm',
  model: 'deepseek-chat',
  apiKey: '',
  temperature: 0.4,
  timeoutMs: 60000,
};

/** 代理层返回的 JSON 形状（成功与失败共用）。 */
interface ProxyResponse {
  ok?: boolean;
  text?: string;
  model?: string;
  error?: string;
  /** 代理层告诉我们它有没有自己的 key——用于「未配置」时的友好提示 */
  hasServerKey?: boolean;
}

/** 把各种失败翻译成**能指导下一步动作**的中文。 */
function explainFailure(status: number, body: ProxyResponse | null, networkError?: string): string {
  if (networkError) {
    return `连不上本地代理（${networkError}）。请确认 dev 服务器在运行（npm run dev），或检查设置里的代理地址`;
  }
  const serverError = body?.error ?? '';
  if (status === 401 || status === 403) {
    return `鉴权失败（HTTP ${status}）。请在服务端设置 DEEPSEEK_API_KEY 环境变量，或（不推荐）在设置里填入 key。${serverError}`;
  }
  if (status === 429) {
    return `请求过于频繁或额度不足（HTTP 429）。稍后重试，或改用离线生成。${serverError}`;
  }
  if (status === 404) {
    return `代理地址不存在（HTTP 404）。请检查设置里的地址（默认 /api/llm）是否为后端所提供。`;
  }
  if (status === 501) {
    return `本地代理未配置（HTTP 501）：服务端没有找到 API key。请设置环境变量 DEEPSEEK_API_KEY 后重启 dev 服务器。${serverError}`;
  }
  if (status >= 500) {
    return `上游或代理报错（HTTP ${status}）。${serverError}`;
  }
  return `请求失败（HTTP ${status}）。${serverError}`;
}

/**
 * 造一个 `Complete` 函数。
 *
 * **超时是自己实现的**（`AbortController` 而不是依赖 fetch 的默认超时）——
 * 默认超时太长（多数环境无限），一个卡住的请求会让界面一直转圈，作者无法判断
 * 「是在算」还是「已经死了」。60 秒后主动中止并给出明确提示。
 */
export function createLlmComplete(settings: () => LlmSettings): Complete {
  return async (request: CompletionRequest): Promise<CompletionResult> => {
    const s = settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, s.timeoutMs));

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // key 留空时不发这个头，让代理层用它自己的环境变量——**这是推荐路径**
    if (s.apiKey.trim()) headers['x-llm-api-key'] = s.apiKey.trim();

    try {
      const response = await fetch(s.endpoint, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: s.model,
          temperature: s.temperature,
          jsonMode: request.jsonMode,
          system: request.system,
          user: request.user,
        }),
      });

      let body: ProxyResponse | null = null;
      try {
        body = (await response.json()) as ProxyResponse;
      } catch {
        body = null; // 代理返回了非 JSON（如 502 的 HTML 错误页）
      }

      if (!response.ok || body?.ok === false) {
        return {
          ok: false,
          text: '',
          error: explainFailure(response.status, body),
        };
      }

      return {
        ok: true,
        text: body?.text ?? '',
        model: body?.model ?? s.model,
      };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        ok: false,
        text: '',
        error: isAbort
          ? `请求超时（${Math.round(s.timeoutMs / 1000)} 秒）。可以在设置里调大超时，或改用离线生成`
          : explainFailure(0, null, err instanceof Error ? err.message : String(err)),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * 探活：问代理层「你配好 key 了吗」。
 *
 * **为什么需要它**：界面上「用大模型生成」这个按钮，在没配 key 时应当**先提示
 * 怎么配**，而不是让作者等 60 秒超时再看一句报错。这个方法让界面在打开设置面板
 * 时就能显示「代理已就绪 / 代理未配置 key」。
 */
export async function probeLlmProxy(endpoint: string): Promise<{ reachable: boolean; hasServerKey: boolean; note: string }> {
  try {
    const response = await fetch(endpoint, { method: 'GET' });
    if (!response.ok) {
      return { reachable: response.status !== 404, hasServerKey: false, note: `代理返回 HTTP ${response.status}` };
    }
    const body = (await response.json()) as ProxyResponse;
    return {
      reachable: true,
      hasServerKey: Boolean(body.hasServerKey),
      note: body.hasServerKey ? '代理已就绪，服务端已配置 API key' : '代理可达，但服务端没有配置 API key',
    };
  } catch (err) {
    return {
      reachable: false,
      hasServerKey: false,
      note: `连不上代理：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
