import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    setupFiles: [path.resolve(__dirname, 'tests/setup.ts')],
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
