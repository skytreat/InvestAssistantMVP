import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    /**
     * 🔴 必须显式指定 root：否则 vitest 用 process.cwd()（仓库根）当 root，
     *   `tests/**` 会解析成 <repo>/tests/** 找不到任何文件（历史静默 0 tests）。
     *   与 packages/core/vitest.config.ts 同理。
     */
    root: __dirname,
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: [path.resolve(__dirname, 'tests/setup.ts')],
    // 不处理 CSS（vitest 默认会把 CSS import 变成空模块）
    css: false,
    // T81 同款守卫：打乱文件顺序 + 用例顺序。CI 另用 --sequence.shuffle 连跑 2 次比对。
    sequence: {
      shuffle: true,
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/main.tsx', // 入口文件（挂载 ReactDOM），无可测逻辑
        'src/types.ts', // 纯类型声明，编译后无运行时代码
        'src/vite-env.d.ts',
      ],
    },
  },
  /**
   * JSX 自动 runtime。
   * 不引 @vitejs/plugin-react：测试不需要 Fast Refresh，
   * esbuild 的 automatic runtime 已足够（tsconfig 的 "jsx": "react-jsx" 也会被 vite 读到，
   * 这里显式声明避免依赖隐式推断）。
   */
  esbuild: {
    jsx: 'automatic',
  },
});
