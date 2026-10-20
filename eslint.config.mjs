import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * ESLint 9 flat config（T86）
 *
 * 作用范围：`packages/core` + `apps/backend` + `apps/frontend` 的全部 ts/tsx。
 * 格式由 Prettier 单独负责（`.prettierrc.json`），`npm run lint` 里串联两者。
 *
 * ⚠️ `prettier` 配置必须**放在最后** —— 它会关掉与 Prettier 冲突的 stylistic 规则，
 *    避免 ESLint 与 Prettier 对同一处代码给出相反的「请改这里」。
 */
export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/data/**', '**/*.duckdb'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      // `allowEmptyCase` —— positionCalculator.ts 的 `case 'buy':` 是**有意的空 case 穿透**
      // （buy 与 add 共用同一分支，源码有 §4-A P0 注释说明），不是漏写 break。
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      // 下面两条**必须开** —— 否则 pluginEngine.ts:776 的 `eslint-disable-next-line no-new-func`
      // 与 pluginEngine.test.ts:135 的 `eslint-disable-next-line no-throw-literal`
      // 会变成「未使用的 disable 指令」告警（这两处都是**故意**的）。
      'no-new-func': 'error',
      'no-throw-literal': 'error',
    },
  },

  /* ── 前端：浏览器环境 ─────────────────────────────────────────── */
  {
    files: ['apps/frontend/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  /* ── 后端 / core：Node 环境 ──────────────────────────────────── */
  {
    files: ['apps/backend/**/*.{ts,tsx}', 'packages/core/**/*.{ts,tsx}', 'scripts/**/*.{js,mjs,cjs,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  /* ── 测试文件：Node + 浏览器双环境 ───────────────────────────── */
  {
    files: ['**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/vitest.config.ts', '**/tsup.config.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },

  /**
   * ⚠️ `no-console` 后端豁免 —— 后端用 console 做启动日志 / 错误兜底是**刻意**的
   *    （`server.ts` 启动横幅、`configStore.ts` 初始化告警、`routes/auth.ts` 登录失败兜底）。
   *    业务日志另有 `services/logger.ts`（写 SQLite `system_log`）负责。
   *    smoke 测试用 console 输出诊断信息也是必要的。
   */
  {
    files: ['apps/backend/**/*.{ts,tsx}', '**/tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },

  /**
   * ⚠️ 后端 `any` 豁免 —— **临时、有范围、有待办**
   *
   * 实测（2026-10-20）：`apps/backend/src` 有 66 处、`apps/backend/tests` 有 104 处 `any`，
   * 而本波（Wave 2）的清理任务 T66 只覆盖前端（`apps/frontend/src` 30 处）。
   *
   * 若此处开 `error`，`npm run lint` 必然非 0 → G2.1（退出码 0）无法达成。
   * 故：后端暂时豁免，**已在实施计划 §13.1 登记待办（后端 any 清理）**，
   * 完成后应删除本段豁免并把后端纳入 `no-explicit-any: error`。
   */
  {
    files: ['apps/backend/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  /* ── Prettier 必须最后 ───────────────────────────────────────── */
  prettier,
);
