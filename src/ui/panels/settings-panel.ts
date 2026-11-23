/**
 * L5 界面层 · 大模型设置面板
 *
 * **key 的存放位置是这个面板最需要解释的一件事。**
 *
 * 推荐用法是**这里什么都不填**：key 放在服务端环境变量（`DEEPSEEK_API_KEY`）里，
 * 由本地代理（`scripts/llm-proxy.mjs`）在转发时才带上。这样 key 不会出现在
 * 浏览器、本地存储或 DevTools 的网络面板里。
 *
 * 因此输入框默认的提示语就是「留空即用服务端环境变量」，并且保存时会**明确告诉
 * 作者他填的这个 key 存在哪**——存在浏览器本地存储里，只在这台机器上有效。
 * 把这件事说清楚比藏起来好：作者知道自己在做什么，才不会在公用电脑上填 key。
 */
import type { SettingsStore } from '../../app/stores/stores.ts';
import { el, fill } from '../components/dom.ts';

export interface SettingsPanelDeps {
  settings: SettingsStore;
  onSave(patch: { endpoint?: string; model?: string; apiKey?: string; temperature?: number }): void;
  onProbe(): void;
}

export interface SettingsPanel {
  root: HTMLElement;
  render(): void;
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  const endpointInput = el('input', { id: 'set-endpoint', class: 'studio-input', type: 'text', 'aria-label': '代理地址' }) as HTMLInputElement;
  const modelInput = el('input', { id: 'set-model', class: 'studio-input', type: 'text', 'aria-label': '模型名' }) as HTMLInputElement;
  const keyInput = el('input', {
    id: 'set-key',
    class: 'studio-input',
    type: 'password',
    placeholder: '留空 = 用服务端环境变量里的 key（推荐）',
    'aria-label': 'API key',
  }) as HTMLInputElement;
  const tempInput = el('input', {
    id: 'set-temp',
    class: 'studio-minutes',
    type: 'number',
    min: '0',
    max: '1.5',
    step: '0.1',
    'aria-label': '采样温度',
  }) as HTMLInputElement;

  const saveButton = el('button', { id: 'set-save', class: 'apply-button', type: 'button', text: '保存设置' });
  const probeButton = el('button', { id: 'set-probe', class: 'quiet-button', type: 'button', text: '检测代理' });
  const statusHost = el('div', { id: 'set-status', class: 'set-status', role: 'status', 'aria-live': 'polite' });

  const root = el('section', { class: 'side-section studio-section' }, [
    el('div', { class: 'section-title' }, [
      el('strong', { text: '大模型设置' }),
      el('span', { class: 'live-label', text: 'LLM' }),
    ]),
    el('p', {
      class: 'muted small',
      text: '大模型用于生成解说草稿。没有配置时，生成会自动改用离线建筑知识表——功能照旧，只是内容更模板化。',
    }),
    el('label', { class: 'studio-field', for: 'set-endpoint' }, [el('span', { text: '代理地址' }), endpointInput]),
    el('p', { class: 'field-hint muted small', text: '默认 /api/llm，由 dev 服务器转发到上游。key 在服务端，不经浏览器。' }),
    el('label', { class: 'studio-field', for: 'set-model' }, [el('span', { text: '模型' }), modelInput]),
    el('label', { class: 'studio-field', for: 'set-key' }, [el('span', { text: 'API key' }), keyInput]),
    el('label', { class: 'studio-inline', for: 'set-temp' }, [
      el('span', { text: '采样温度' }),
      tempInput,
    ]),
    el('p', {
      class: 'field-hint muted small',
      text: '填了 key 的话，它只保存在这台机器的浏览器本地存储里，不会写进任何工程文件。',
    }),
    el('div', { class: 'draft-actions' }, [saveButton, probeButton]),
    statusHost,
  ]);

  saveButton.addEventListener('click', () => {
    const temperature = Number(tempInput.value);
    deps.onSave({
      endpoint: endpointInput.value.trim() || '/api/llm',
      model: modelInput.value.trim() || 'deepseek-chat',
      apiKey: keyInput.value.trim(),
      temperature: Number.isFinite(temperature) ? Math.min(1.5, Math.max(0, temperature)) : 0.4,
    });
  });

  probeButton.addEventListener('click', () => deps.onProbe());

  function render(): void {
    const state = deps.settings.get();
    // ★ 只在**未聚焦**时回写输入框。否则订阅触发的重绘会把作者正在输入的
    //   光标打断（关掉每一个键就重置一次），这是这类面板最常见的体验缺陷。
    if (document.activeElement !== endpointInput) endpointInput.value = state.llm.endpoint;
    if (document.activeElement !== modelInput) modelInput.value = state.llm.model;
    if (document.activeElement !== keyInput) keyInput.value = state.llm.apiKey;
    if (document.activeElement !== tempInput) tempInput.value = String(state.llm.temperature);

    const tone = state.proxyReachable === null ? '' : state.proxyReachable && state.proxyHasKey ? 'ok' : 'warn';
    fill(statusHost, [
      el('p', { class: `set-note set-note-${tone || 'idle'}`, text: state.proxyNote }),
    ]);
  }

  return { root, render };
}
