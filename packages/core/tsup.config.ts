import { defineConfig } from 'tsup';

export default defineConfig([
  // ESM build
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    outDir: 'dist/esm',
    clean: false,
    splitting: false,
    sourcemap: false,
  },
  // CJS build
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    outDir: 'dist/cjs',
    clean: false,
    splitting: false,
    sourcemap: false,
    extension: { js: '.cjs' },
  },
]);
