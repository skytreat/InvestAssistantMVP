import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // 必须显式指定 root：否则 vitest 用 process.cwd()（仓库根）当 root，
    // `tests/**` 会解析成 <repo>/tests/** 找不到任何文件（历史静默 0 tests）
    root: __dirname,
    globals: true,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/**/*.ts'],
    },
  },
});
