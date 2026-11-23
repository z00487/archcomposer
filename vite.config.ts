/**
 * Vite 配置（含 Vitest）
 *
 * 依据：《项目概要设计文档》§7.1 的目录结构（「新增 `vite.config.ts`，含 vitest 配置」）。
 *
 * **默认测试环境是 `node`**：这是约束 C-1 的直接体现——L3 领域层
 * （意图、求解、保真度、分镜完整性）的全部测试都**不需要 DOM、不需要 WebGL**。
 * 若哪天有算法测试必须用 DOM 才能跑，那说明有渲染依赖漏进了领域层，
 * `scripts/check-layering.ts` 会在 CI 里先一步报出来。
 *
 * **唯一的例外是 `src/__tests__/ui.test.ts`**：它测的是 L5 界面层，需要的正是 DOM。
 * 该文件用 `@vitest-environment happy-dom` 文档注释就近声明自己的环境，
 * 不影响其它文件——这样「哪些测试需要 DOM」这件事在文件里就能看到。
 *
 * 为什么是 `happy-dom` 而不是 `jsdom`：本沙箱里 `jsdom` 的模块加载耗时约 95 秒，
 * 超过了 Vitest 的 worker 启动超时（60 秒），测试跑不起来；
 * `happy-dom` 约 40 秒，能跑通。这个选择是**环境所迫而非偏好**，
 * 在有正常网络的开发机上两者都可以，换回 jsdom 只需改那一行注释。
 */
import { defineConfig } from 'vite';

export default defineConfig({
  // 相对基路径。
  //
  // ⚠️ 这**不是**为了「直接用 file:// 双击打开」——本项目做不到那个，
  //    因为模型与示例分镜是用 fetch() 载入的，而 file:// 下 fetch 会被 CORS 拦掉。
  //    相对的资产路径让 dist/ 可以放在**任意子路径下**提供服务
  //    （例如 http://host/课程/archcomposer/），这才是它的用处。
  //    NFR-4 的「纯浏览器运行」指的是「只要有浏览器和一台静态服务器就行」，
  //    不含「零服务器」。本地预览一条命令：npm run preview。
  base: './',
  build: {
    outDir: 'dist',
    // three 的体积本来就大，把阈值调高以免每次构建都被无意义的警告刷屏
    chunkSizeWarningLimit: 900,
  },
  test: {
    // 默认：领域层测试不需要 DOM
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // 严格模式：任何未处理的 Promise 拒绝都让测试失败
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
