import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 15000,
    setupFiles: [path.resolve(__dirname, 'tests/setup.ts')],
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
