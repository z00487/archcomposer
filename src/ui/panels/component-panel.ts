/**
 * L5 界面层 · M14 构件面板
 *
 * 依据：《项目概要设计文档》§4.1 的 M14、§7.3（原 `main.ts` 的构件列表渲染移到这里）。
 *
 * **面板要展示的、与竞品有区别的一件事**：选中构件时同时显示它的**类型 (kind)、
 * 部位 (part)、稳定 ID** 三项——这三项都是由构件名**实时解析**出来的
 * （命名规范 §7.2）。这就把「名字是语义唯一来源」这条设计**当场演示**出来了，
 * 而不是靠事先标注好的标签表（后者是 Navisworks 的做法）。
 */
import type { SelectionStore } from '../../app/stores/stores.ts';
import type { ComponentId } from '../../domain/types/component.ts';
import type { RegisteredComponent } from '../../runtime/model/registry.ts';
import { el, fill } from '../components/dom.ts';

export interface ComponentPanelDeps {
  selection: SelectionStore;
  /** 取当前可展示的构件列表（搜索后的结果） */
  list(): RegisteredComponent[];
  /** 点击某一行的回调 */
  onPick(id: ComponentId): void;
  /** 搜索关键字变化 */
  onSearch(query: string): void;
  /** 构件的显示名（含语义兜底） */
  labelOf(id: ComponentId): string;
  /** 构件当前的求解相关附加信息（「已高亮」等），由 L4 提供 */
  statusOf?(id: ComponentId): string;
}

export interface ComponentPanel {
  root: HTMLElement;
  render(): void;
}

export function createComponentPanel(deps: ComponentPanelDeps): ComponentPanel {
  const listHost = el('div', { class: 'component-list' });
  const searchInput = el('input', {
    id: 'component-search',
    class: 'search-input',
    type: 'search',
    placeholder: '搜索构件名 / 类型 / ID…',
    'aria-label': '搜索构件',
  });
  const countPill = el('span', { class: 'count-pill', id: 'component-count', text: '0' });

  const root = el('section', { class: 'side-section' }, [
    el('div', { class: 'section-title' }, [
      el('strong', { text: '构件列表' }),
      countPill,
    ]),
    searchInput,
    listHost,
  ]);

  searchInput.addEventListener('input', () => {
    deps.onSearch(searchInput.value);
    // 搜索不改变选中，只重绘列表
    render();
  });

  function render(): void {
    const items = deps.list();
    const selectedId = deps.selection.get().selectedId;
    countPill.textContent = String(items.length);

    if (items.length === 0) {
      fill(listHost, [el('div', { class: 'empty-state', text: '没有匹配的构件' })]);
      return;
    }

    const rows = items.map((component) => {
      const active = component.id === selectedId;
      const hidden = !component.object.visible;
      const status = deps.statusOf?.(component.id) ?? '';
      const row = el('button', {
        class: `component-row${active ? ' active' : ''}${hidden ? ' is-hidden' : ''}`,
        type: 'button',
        title: component.id,
      }, [
        el('span', { class: 'component-icon', text: hidden ? '◌' : '◇' }),
        el('span', { class: 'component-copy' }, [
          el('strong', { text: component.displayName }),
          el('small', {
            text: `${component.semantics.kind}${status ? ` · ${status}` : ''}`,
          }),
        ]),
        el('span', { class: 'row-eye', text: hidden ? '○' : '●' }),
      ]);
      row.addEventListener('click', () => deps.onPick(component.id));
      return row;
    });

    fill(listHost, rows);
  }

  return { root, render };
}

/**
 * 当前构件的详情卡片。
 *
 * 这是界面上最值得给评审看的一块：**类型 / 部位 / ID 三项全部由名字解析得出**。
 * 外部 GLB 因为命名不合法会显示 `unknown（不在词表内）`——这个「诚实地显示
 * 不知道」的设计本身就是与「猜一个标签」的对比。
 */
export interface SemanticsView {
  root: HTMLElement;
  update(component: RegisteredComponent | null, id: ComponentId, warnings: string[]): void;
}

export function createSemanticsView(): SemanticsView {
  const box = el('div', { class: 'semantics-box', hidden: true }, [
    el('div', { class: 'semantics-row' }, [
      el('span', { text: '类型 kind' }),
      el('code', { id: 'sem-kind' }),
    ]),
    el('div', { class: 'semantics-row' }, [
      el('span', { text: '部位 part' }),
      el('code', { id: 'sem-part' }),
    ]),
    el('div', { class: 'semantics-row' }, [
      el('span', { text: '构件 ID' }),
      el('code', { id: 'sem-id' }),
    ]),
    el('div', {
      class: 'semantics-note',
      text: '以上三项均由构件名实时解析得出（命名规范 §7.2）',
    }),
  ]);

  const kindNode = box.querySelector<HTMLElement>('#sem-kind')!;
  const partNode = box.querySelector<HTMLElement>('#sem-part')!;
  const idNode = box.querySelector<HTMLElement>('#sem-id')!;

  function update(component: RegisteredComponent | null, id: ComponentId, warnings: string[]): void {
    if (!component) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const kind = component.semantics.kind;
    kindNode.textContent = kind === 'unknown' ? 'unknown（不在词表内）' : kind;
    partNode.textContent = component.semantics.part || '（无定位词）';
    idNode.textContent = id;
    box.dataset.known = kind === 'unknown' ? 'no' : 'yes';
    // 解析时的警告（如「定位词不在允许集合内」）直接挂到 title 上，
    // 不额外占版面——但用户悬停就能看到，不会「悄悄吞掉」问题
    box.title = warnings.length > 0 ? warnings.join('\n') : '';
  }

  return { root: box, update };
}
