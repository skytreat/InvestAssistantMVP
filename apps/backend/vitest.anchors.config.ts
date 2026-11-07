import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 🔒 **锚点用例专用配置（手动跑，必须真库）**
 *
 * 背景：这些用例断言的是**真库规模 / 具体历史日期上的数值事实**（1.24GB 真库才有的
 * 5561 只标的、2172.6 万/日 流动性阈值等）。它们与日常套件混跑时，会：
 *   ① 拉起真库 ⇒ 进程内存峰值 ~3.65 GB（日常 `npm test` 的主要内存成本）；
 *   ② 在 CI（只有迷你库）下静默 skip ⇒ 没人知道它们到底还对不对。
 *
 * ⇒ 拆成独立配置 + 独立 npm script（`npm run test:anchors -w @invest/backend`），
 *   日常 `npm test` 通过 `vitest.config.ts` 的 `exclude` 把它们排除。
 *
 * 🔴 **环境必须显式配好**：`tests/anchors.setup.ts` 会在开跑前校验档位必须是 `full`
 *   且真库探测可用，**不满足直接抛错**（不是 skip）—— 手跑时环境没配对必须红灯，
 *   不能假绿。真库路径来自 `.env.local` 的 `DUCKDB_PATH`（或命令行覆盖）。
 */
export default defineConfig({
  test: {
    root: __dirname,
    include: ['tests/**/*.anchors.test.ts'],
    // 单进程 + 单 fork：DuckDB 文件锁是排他的，多 worker 会各开一个实例抢锁
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    maxWorkers: 1,
    // 真库查询要物化复权视图（实测单条可达 11~12s），再叠加面板装载 ⇒ 放宽到 180s
    testTimeout: 180000,
    // 顺序无关：anchors 每个文件都自洽，不依赖文件间顺序
    sequence: {
      shuffle: false,
    },
    globals: true,
    setupFiles: [path.resolve(__dirname, 'tests/setup.ts'), path.resolve(__dirname, 'tests/anchors.setup.ts')],
    env: {
      JWT_SECRET: 'investassistant-mvp-test-secret-for-unit-tests-only',
    },
    resolve: {
      alias: {
        '@invest/core': path.resolve(__dirname, '../core/src/index.ts'),
      },
    },
  },
});
