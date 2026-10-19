import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
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
