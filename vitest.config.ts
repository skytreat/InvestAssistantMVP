import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      '@invest/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
    },
  },
});
