import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 🔴 **`tests/http/` 专用配置** —— 「**真 listen**」的 HTTP 层验收套件
 *
 * ── 为什么必须独立配置 ──
 *   ① **隔离**：主配置 `vitest.config.ts` 的 `include` 覆盖 `tests/` 下的全部 `.test.ts`
 *      ⇒ 会把本目录吸进去 ⇒ 必须在那里 `exclude` 掉（见该文件的 exclude 段）。
 *   ② **单进程**：DuckDB 的文件锁是**排他**的 ⇒ 多个 worker 并行跑会互相抢锁
 *      （实测报 `IO Error: Could not set lock on file …`）⇒ 必须 `singleFork`。
 *   ③ **不 shuffle**：PE2（选股 ≤3s）是**性能门槛**，需要可控的测量环境
 *      （文件顺序固定 + 文件内 `beforeAll` 主动丢弃 DuckDB 单例）。
 *
 * ── 本套件覆盖（计划 §12.7 T60 ③）──
 *   | 文件 | 判据 |
 *   |---|---|
 *   | `cors.test.ts` | CORS：evil.com 必拒 / 127.0.0.1:5173 必放行 + 「确实 listen」守卫 |
 *   | `https-se1.test.ts` | SE1：HTTPS 强制（HTTP 301）|
 *   | `pe1-pe3-browser.test.ts` | PE1 首屏 ≤1.5s / PE3 K 线首渲染 FP ≤500ms（真浏览器）|
 *   | `pe2-scan.test.ts` | PE2 选股 ≤3s（5000+ 标的）|
 *   | `pe4-holding-p99.test.ts` | PE4 API 单请求 p99 ≤200ms（30 只持仓）|
 *   | `pe5-sqlite-concurrency.test.ts` | PE5 SQLite WAL 10 并发读写不出现 SQLITE_BUSY |
 *   | `holding-nplus1.test.ts` | N+1 消除（查询次数不随标的数线性增长）|
 *
 * ── 运行方式 ──
 *   ```bash
 *   # 常规（含 mini 档行情库；规模/性能型用例会 skip 并留痕）
 *   npm run test:http -w @invest/backend
 *
 *   # 门禁前（真库 —— PE1~PE5 的规模/性能判据必须有真库）
 *   DUCKDB_PATH=/opt/invol/quotes.duckdb MARKET_DATA_MODE=full \
 *     npx vitest run --config vitest.http.config.ts
 *   ```
 */
export default defineConfig({
  test: {
    root: __dirname,
    include: ['tests/http/**/*.test.ts'],
    globals: true,
    // 性能门槛用例耗时较长（PE2 全市场选股、PE4 多轮 p99、真浏览器加载）
    testTimeout: 300_000,
    hookTimeout: 300_000,
    setupFiles: [path.resolve(__dirname, 'tests/setup.ts')],
    // ⚠️ 单进程单线程：DuckDB 文件锁排他 ⇒ 并行 worker 会互相抢锁
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    // ⚠️ 不 shuffle：性能门槛需要可控的测量环境（见文件头 ③）
    sequence: { shuffle: false },
    resolve: {
      alias: {
        '@invest/core': path.resolve(__dirname, '../core/src/index.ts'),
      },
    },
  },
});
