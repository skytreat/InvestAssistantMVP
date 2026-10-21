import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    /**
     * 🔴 **必须显式指定 `root` 与 `include`**（2026-10-21 实测踩坑）：
     *
     * ① `setupFiles` 的 env 守卫**从未在 CI 上生效** ——
     *    CI 的命令是 `npx vitest run apps/backend/tests/unit --coverage`（**在仓库根跑**），
     *    根目录**没有** vitest config ⇒ 走 vitest 默认配置 ⇒ **不带 `setupFiles`**
     *    ⇒ `tests/setup.ts` 的两级 env 基线守卫**完全没跑**
     *    ⇒ 测试文件顶层写的 `DUCKDB_PATH` 等**在同进程的后续文件里泄漏**
     *    ⇒ 行情库档位被误判（详见 `_marketData.ts` 的 `resolveMarketData`）。
     *
     * ② `coverage.include` 里的 src 路径相对 **cwd** 解析 ——
     *    在仓库根跑时匹配的是 `<repo>/src/`（**不存在**）⇒ **后端覆盖率一直是 0%**。
     *
     * ⇒ 显式 `root: __dirname` 后，`include` / `coverage.include` / `setupFiles`
     *    都相对 `apps/backend/` 解析 ⇒ **任何 cwd 下都正确**。
     */
    root: __dirname,
    include: ['tests/**/*.test.ts'],
    /**
     * ⚠️ **排除 PE2 性能门槛用例**（2026-10-21 实测）：
     *   `tests/integration/scan5000.test.ts` 测「全市场条件选股 ≤ 3s」（SDD §12.5 F7 / G6.4）。
     *   它**必须独占运行**：与全量套件同进程跑时耗时 **10082ms**、单独跑 **2942ms**
     *   ⇒ 根因是 `src/db/duckdb.ts` 的**进程内单例 DuckDB** 的内部缓冲被前面几十个测试驱逐
     *   ⇒ 性能门槛在受控环境外测没有意义。
     * ⇒ 门禁 G6.4 的判据方式：**`npm run test:pe2 -w @invest/backend`**（见 `vitest.pe2.config.ts`）。
     */
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,eslint,prettier}.config.*',
      'tests/integration/scan5000.test.ts',
    ],
    globals: true,
    testTimeout: 15000,
    setupFiles: [path.resolve(__dirname, 'tests/setup.ts')],
    /**
     * 🔴 `test.env` 是 vitest **官方**的 env 注入方式 —— 在任何模块被求值**之前**
     *   写进 `process.env`，**不受 coverage 插桩影响**。
     *
     * 为什么必须有它（2026-10-19 实测踩坑）：
     *   `coverage.include`（src 目录下所有 .ts）会让 v8 provider **提前加载**源文件，
     *   此时 `tests/setup.ts` 还没跑 → `setup.ts` 里的 JWT_SECRET 兜底来不及生效
     *   → `auth.ts` 读不到密钥 → 带 `--coverage` 时 4 个测试文件在收集阶段就失败。
     *   （`setup.ts` 里的兜底在**没有** coverage 时是有效的，但它依赖「setupFiles 先于
     *    源文件求值」这个假设，coverage 会打破该假设。）
     *
     * 这是一个**测试专用**的密钥，与生产无关 —— 生产由 `docs/deploy.md` §3 的
     * `JWT_SECRET` 环境变量提供；`auth.ts` 已改为**惰性读取**并在缺失时拒绝签名。
     */
    env: {
      JWT_SECRET: 'investassistant-mvp-test-secret-for-unit-tests-only',
    },
    // T81（F-Q11）顺序敏感守卫：每次运行都打乱「文件顺序 + 文件内用例顺序」。
    // 用例之间若存在隐式顺序依赖（env 泄漏 / ConfigStore 单例 / DuckDB 单例残留），
    // 打乱后必然随机失败 —— 靠固定顺序侥幸通过的用例会在这里暴露。
    // CI 另用 `--sequence.shuffle` 连跑 2 次 + 结果比对做二次守卫。
    sequence: {
      shuffle: true,
    },
    resolve: {
      alias: {
        '@invest/core': path.resolve(__dirname, '../core/src/index.ts'),
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json', 'json-summary'],
      include: ['src/**/*.ts'],
    },
  },
});
