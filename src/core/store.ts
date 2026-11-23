/**
 * L1 基础设施 · Observable Store 基类
 *
 * 依据：《项目概要设计文档》§3.4 —— 跨层通信只用两种方式，其中「向上通知」就是
 * 这一个（`on('change', cb)`）。**刻意不引入事件总线**：事件总线会让调用关系
 * 无法静态分析，而本项目只有五层且依赖单向，不需要它。
 *
 * 设计取舍：**状态不可变**。`set` 接收一个纯函数，返回新的状态对象，而不是
 * 就地修改。理由是分镜编辑需要撤销/重做与「播放不改数据」（§6.3）——若状态
 * 就地修改，这两条都做不成。代价是每次变更都要浅拷贝一次对象，对这个体量的
 * 数据（几十个步骤）完全可以接受。
 */

export type Listener<S> = (state: S, prev: S) => void;
export type Unsubscribe = () => void;

export class Store<S extends object> {
  private state: S;
  private listeners = new Set<Listener<S>>();
  private readonly name: string;

  constructor(initial: S, name = 'store') {
    this.state = initial;
    this.name = name;
  }

  /** 只读快照。返回的是同一个引用——调用方不得修改它。 */
  get(): Readonly<S> {
    return this.state;
  }

  /**
   * 以纯函数更新状态。若 `updater` 返回的对象与当前状态**引用相同**，
   * 视为「无变更」，不通知订阅者——避免无意义的重渲染。
   */
  set(updater: (state: Readonly<S>) => S): void {
    const prev = this.state;
    const next = updater(prev);
    if (next === prev) return;
    this.state = next;
    this.emit(next, prev);
  }

  /** 便捷方法：局部合并。等价于 `set(s => ({ ...s, ...patch }))`。 */
  patch(patch: Partial<S>): void {
    this.set((s) => ({ ...s, ...patch }));
  }

  /**
   * 订阅变更。**立即用当前状态回调一次**，这样 UI 不需要「先手动渲染一次、
   * 再订阅」这种容易漏掉的分步写法。
   */
  subscribe(listener: Listener<S>): Unsubscribe {
    this.listeners.add(listener);
    listener(this.state, this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(next: S, prev: S): void {
    for (const listener of this.listeners) {
      try {
        listener(next, prev);
      } catch (err) {
        // 一个订阅者抛错不应阻断其它订阅者——否则一个 UI 组件的 bug 会让
        // 整个应用的状态通知链断掉，且现象极难排查。
        console.error(`[${this.name}] 订阅者抛出异常：`, err);
      }
    }
  }
}

/**
 * 派生 Store：从多个源 Store 计算出一个只读视图，源变更时自动重算。
 *
 * 用途：步骤面板需要「当前分镜 + 当前选中」两者共同决定的高亮状态。
 * 若不用它，就得在每个 UI 组件里各自手写一套订阅叠加逻辑。
 */
export function derived<T>(
  sources: Array<Store<any>>,
  compute: () => T,
  name = 'derived',
): Store<{ value: T }> {
  const store = new Store<{ value: T }>({ value: compute() }, name);
  const recompute = (): void => {
    store.set((prev) => {
      const next = compute();
      return Object.is(next, prev.value) ? prev : { value: next };
    });
  };
  for (const source of sources) source.subscribe(recompute);
  return store;
}
