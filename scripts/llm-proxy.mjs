/**
 * 本地 LLM 代理（开发中间件 + 独立服务器，二者共用同一份处理逻辑）
 *
 * **这个文件的唯一职责是「把 API key 挡在浏览器之外」。**
 * 浏览器只跟同源的 `/api/llm` 说话；本进程读环境变量里的 key，转发给上游厂商。
 * 于是：
 *   - key 不出现在前端代码、本地存储、或 DevTools 的网络面板里；
 *   - 不受浏览器 CORS 限制（服务端到服务端没有同源策略）；
 *   - 没配 key 时明确回 501，前端据此走离线回退，而不是让作者等到超时。
 *
 * **两种用法**：
 *   1. `npm run dev` —— `vite.config.ts` 引本文件作为 dev 中间件（推荐，零额外进程）；
 *   2. `node scripts/llm-proxy.mjs` —— 独立起一个服务（供 `npm run preview` 或
 *      纯静态部署时用，端口由 LLM_PROXY_PORT 指定，默认 8787）。
 *
 * **安全立场**：
 *   - key 只从环境变量读，**不写日志、不回显**；
 *   - 只允许 POST（带 body）与 GET（探活），不给它当通用代理用的机会；
 *   - 上游地址由环境变量控制而不是由请求体控制——否则这个代理就成了
 *     「任何人都能用我们的 key 打任意地址」的 SSRF 跳板。
 */

/** 从环境变量读配置。每次调用都重读，便于改 .env 后重启即生效。 */
export function readProxyConfig(env = process.env) {
  return {
    apiKey: env.DEEPSEEK_API_KEY || env.LLM_API_KEY || '',
    upstream: env.LLM_UPSTREAM || 'https://api.deepseek.com/v1/chat/completions',
    defaultModel: env.LLM_MODEL || 'deepseek-chat',
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 60000),
  };
}

/** 读取请求体（Node 原生 http 的 IncomingMessage 不是流式的便利对象）。 */
function readBody(req, limitBytes = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 同源请求其实用不到 CORS 头；打上是为了让「前端在另一个端口」这种
  // 开发布局也能用（如 vite 在 5173、代理在 8787）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-llm-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.end(body);
}

/**
 * 处理一个 `/api/llm` 请求。
 *
 * 返回 `true` 表示「这个请求由我处理了」，`false` 表示「不是我管的路由」——
 * 后者让 vite 中间件可以把请求交回给静态资源服务。
 */
export async function handleLlmRequest(req, res, pathname) {
  if (!pathname.startsWith('/api/llm')) return false;

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return true;
  }

  const config = readProxyConfig();

  // ── 探活：界面用它在打开设置面板时显示「代理是否就绪」 ──
  //
  // ★ 只回「有没有配 key」这个布尔值，**绝不回显 key 本身**（哪怕是前缀）。
  //   回显前缀看起来贴心，实际是把凭据泄漏到了浏览器端。
  if (req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      hasServerKey: Boolean(config.apiKey),
      upstream: config.upstream.replace(/\/\/[^/]+/, '//***'), // 隐去主机名里的潜在凭据
      defaultModel: config.defaultModel,
    });
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 GET（探活）与 POST（补全）' });
    return true;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `请求体不是合法 JSON：${err.message}` });
    return true;
  }

  // key 的来源有两处，服务端环境变量**优先**（那是推荐路径）。
  // 请求头里的 key 只作为「没有代理配置」时的逃生口，并且不进日志。
  const headerKey = req.headers['x-llm-api-key'];
  const apiKey = config.apiKey || (typeof headerKey === 'string' ? headerKey.trim() : '');

  if (!apiKey) {
    sendJson(res, 501, {
      ok: false,
      error: '服务端没有配置 API key：请设置环境变量 DEEPSEEK_API_KEY（见 .env.example）后重启',
      hasServerKey: false,
    });
    return true;
  }

  // 组装上游请求。OpenAI 兼容格式（DeepSeek 遵循它）。
  const body = {
    model: typeof payload.model === 'string' && payload.model ? payload.model : config.defaultModel,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.4,
    messages: [
      { role: 'system', content: String(payload.system ?? '') },
      { role: 'user', content: String(payload.user ?? '') },
    ],
    stream: false,
    // OpenAI 兼容的 JSON 模式。上游若不支持，会在 body 里报错，这里透传出来。
    ...(payload.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.upstream, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      // ★ 上游的错误正文原样透传（它通常写明是 key 无效还是额度不足），
      //   但**不包含我们发出去的 key**——它只在请求头里，不在响应里。
      sendJson(res, response.status, {
        ok: false,
        error: `上游返回 HTTP ${response.status}：${raw.slice(0, 400)}`,
        model: body.model,
      });
      return true;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 502, { ok: false, error: `上游返回的不是 JSON：${raw.slice(0, 200)}` });
      return true;
    }

    const text = parsed?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      sendJson(res, 502, {
        ok: false,
        error: `上游响应里没有 choices[0].message.content，实际结构：${JSON.stringify(parsed).slice(0, 300)}`,
      });
      return true;
    }

    sendJson(res, 200, {
      ok: true,
      text,
      model: parsed?.model ?? body.model,
      usage: parsed?.usage ?? null,
    });
    return true;
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    sendJson(res, isAbort ? 504 : 502, {
      ok: false,
      error: isAbort
        ? `上游请求超时（${Math.round(config.timeoutMs / 1000)} 秒）`
        : `请求上游失败：${err?.message ?? String(err)}`,
    });
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** Vite 插件：把 `/api/llm` 挂到 dev server 上。 */
export function llmProxyPlugin() {
  return {
    name: 'archcomposer-llm-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url || '').split('?')[0];
        handleLlmRequest(req, res, pathname)
          .then((handled) => {
            if (!handled) next();
          })
          .catch((err) => {
            sendJson(res, 500, { ok: false, error: `代理内部错误：${err?.message ?? String(err)}` });
          });
      });

      // 启动时把「有没有配 key」打出来——**只打布尔值，绝不打 key 本身**。
      const config = readProxyConfig();
      server.config.logger.info(
        config.apiKey
          ? '  ➜  LLM 代理：/api/llm → 已配置 API key（服务端环境变量）'
          : '  ➜  LLM 代理：/api/llm → 未配置 API key，前端将回退到离线生成（设置 DEEPSEEK_API_KEY 可启用大模型）',
      );
    },
  };
}

// ── 独立运行：`node scripts/llm-proxy.mjs` ─────────────────────
//
// 用 `import.meta.url` 判断是不是被直接执行——被 import 时不启服务器。
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const { createServer } = await import('node:http');
  const port = Number(process.env.LLM_PROXY_PORT || 8787);
  const config = readProxyConfig();

  createServer((req, res) => {
    const pathname = (req.url || '').split('?')[0];
    handleLlmRequest(req, res, pathname)
      .then((handled) => {
        if (!handled) sendJson(res, 404, { ok: false, error: '只提供 /api/llm 这一个端点' });
      })
      .catch((err) => sendJson(res, 500, { ok: false, error: String(err) }));
  }).listen(port, () => {
    console.log(`LLM 代理已启动：http://127.0.0.1:${port}/api/llm`);
    console.log(config.apiKey ? '  API key：已配置（来自环境变量）' : '  API key：未配置 —— 请求会得到 501，前端会自动回退到离线生成');
    console.log('  提示：把界面设置里的代理地址改成这个地址即可使用。');
  });
}
