/**
 * L5 界面层 · 通用控件
 *
 * 依据：《项目概要设计文档》§7.1 的 `ui/components/`、§3.3（L5「呈现与交互」，
 * 不含业务规则）。
 *
 * **本层的一条纪律：不含任何业务规则。** 所有判断（哪一步该标黄、求解成功与否）
 * 都由下层算好放在 Store 里，UI 只做映射。这样「规则改了要改几处」这个问题
 * 在 UI 上永远只有一个答案：零处。
 */

/** 极小的 DOM 构造助手，避免满屏 `document.createElement`。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | undefined> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** 按 id 取元素，同时做非空断言——模板里的 id 是固定的，取不到就是编码错误。 */
export function byId<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`缺少 DOM 元素 #${id}，界面模板与代码不同步`);
  return found as T;
}

/**
 * 清空一个容器并塞入新内容。
 *
 * **用 `replaceChildren` 而不是 `innerHTML = ''` 再 append**：前者只触发一次回流，
 * 且在步骤列表拖拽排序时不会出现「先全空再填充」的闪烁。
 */
export function fill(container: HTMLElement, children: Node[]): void {
  container.replaceChildren(...children);
}

/** 求解状态 → CSS 类名（颜色语义集中在此）。 */
export function solveStateClass(state: string): string {
  switch (state) {
    case 'solved':
      return 'is-solved';
    case 'stale':
      return 'is-stale';
    case 'failed':
      return 'is-failed';
    default:
      return 'is-none';
  }
}

/** 求解状态 → 徽章文字。 */
export function solveStateBadge(state: string): string {
  switch (state) {
    case 'solved':
      return '已求解';
    case 'stale':
      return '待重算';
    case 'failed':
      return '求解失败';
    default:
      return '未求解';
  }
}

/** 转义：构件名来自模型文件，可能含 HTML 特殊字符。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
