import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 🔴 **PE2 性能门槛的专用配置**（G6.4 / SDD §12.5 F7：全市场条件选股 ≤ 3s）
 *
 * ⚠️ **为什么必须隔离跑**（2026-10-21 实测）：
 *   PE2 与全量套件**同进程跑**时耗时 **10082ms**（远超 3s 门槛），
 *   而**单独跑**是 **2942ms**（通过）。
 *   ⇒ 根因不是选股逻辑变慢，而是 **`src/db/duckdb.ts` 的进程内单例 DuckDB 实例**
 *     的内部缓冲被前面几十个测试的查询**驱逐**（page cache 争用），
 *     且单例的 buffer 不按查询重置 ⇒ 同一个查询在「冷缓冲」下就是慢 3.4 倍。
 *   ⇒ **性能门槛只能在受控环境测** —— 这与业界通行做法一致。
 *
 * ⇒ 门禁 G6.4 的**唯一**判据方式：`npm run test:pe2 -w @invest/backend`
 *   （需本机有真行情库；`MARKET_DATA_MODE=full` + `DUCKDB_PATH` 指向真库）
 */
export default defineConfig({
  test: {
    root: __dirname,
    include: ['tests/integration/scan5000.test.ts'],
    globals: true,
    // 性能测量**不能**有默认的 15s 上限之外的时间压力 ⇒ 给足超时
    testTimeout: 300000,
    hookTimeout: 300000,
    setupFiles: [path.resolve(__dirname, 'tests/setup.ts')],
    // ⚠️ 单线程 + 独占进程 ⇒ 测量环境干净
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
