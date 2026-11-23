/**
 * L3 领域层 · M8 求解器注册表（约束 C-2 / NFR-7）
 *
 * 依据：《项目概要设计文档》§4.2.2「关键设计决定：`ViewSolver` 必须是接口，
 * 且实现必须可注册」。
 *
 * 任务一 §4.3 提到「CinemaTraj 的相机求解与优化可以作为我们重定向层的求解器
 * 直接使用」，NFR-7 也要求求解器可替换。因此架构上必须支持**换求解器不改调用方**：
 * 调用方（M11 commands）只认 `ViewSolver` 接口，实现族从这里按名取用。
 */
import type { SolveRequest, SolveResult, ViewSolver } from '../types/solver.ts';
import { SamplingSolver } from './solver.ts';

/**
 * 注册表实现。
 *
 * **注意它不是全局单例**：实例由 main.ts 在装配阶段创建并注入。全局单例会让
 * Vitest 测试之间互相污染（一个测试注册的假求解器泄漏到下一个测试），
 * 这是小项目里最常见的测试不稳定的来源。
 */
export class SolverRegistry {
  private readonly solvers = new Map<string, ViewSolver>();
  private defaultName: string | null = null;

  /**
   * 注册一个求解器。`asDefault` 为 true 时同时设为默认。
   *
   * 重复注册同名求解器会抛错而不是静默覆盖——静默覆盖会让「我明明换了实现却没
   * 生效」这类问题极难排查，而抛错当场就能发现。
   */
  register(solver: ViewSolver, asDefault = false): this {
    if (this.solvers.has(solver.name)) {
      throw new Error(`求解器「${solver.name}」已被注册，请先注销或改用其它名字`);
    }
    this.solvers.set(solver.name, solver);
    if (asDefault || this.defaultName === null) this.defaultName = solver.name;
    return this;
  }

  unregister(name: string): boolean {
    const existed = this.solvers.delete(name);
    if (this.defaultName === name) {
      this.defaultName = this.solvers.keys().next().value ?? null;
    }
    return existed;
  }

  has(name: string): boolean {
    return this.solvers.has(name);
  }

  list(): string[] {
    return [...this.solvers.keys()];
  }

  get defaultSolverName(): string | null {
    return this.defaultName;
  }

  setDefault(name: string): void {
    if (!this.solvers.has(name)) throw new Error(`未注册的求解器「${name}」`);
    this.defaultName = name;
  }

  /** 按名取用；不传名字则取默认求解器。 */
  get(name?: string): ViewSolver {
    const key = name ?? this.defaultName;
    if (key === null) throw new Error('求解器注册表为空，请先 register 一个实现');
    const solver = this.solvers.get(key);
    if (!solver) throw new Error(`未注册的求解器「${key}」，已注册：${this.list().join(', ') || '（空）'}`);
    return solver;
  }

  /**
   * 便捷求解。**调用方（M11）应当用这个而不是直接 get().solve()**——
   * 这样将来要加「超时保护」「多求解器投票」这类策略时，只需改这里一处。
   */
  solve(request: SolveRequest, name?: string): SolveResult {
    return this.get(name).solve(request);
  }
}

/**
 * 建一个装了默认实现的注册表。
 *
 * 第一版只有「候选采样 + 打分」一个实现。将来把 CinemaTraj 风格的 SDF 优化器
 * 实现为 `SdfRefineSolver` 插进来即可：
 *
 * ```ts
 * registry.register(new SdfRefineSolver(), false);
 * ```
 *
 * 调用方一行都不用改——这就是约束 C-2 要买到的东西。
 */
export function createDefaultRegistry(): SolverRegistry {
  return new SolverRegistry().register(new SamplingSolver(), true);
}
