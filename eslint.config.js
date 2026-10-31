import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 插件是独立进程的产物（Python 依赖 21MB 预装），不在本仓库 lint 范围内；
  // data/ 下是运行时产物 —— 注意录制分段叫 .ts（MPEG-TS），不是 TypeScript
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'plugins/**', 'data/**', 'vendor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'warn',
      // 接口实现里用不到的参数用下划线前缀表达"刻意不用"
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
  // tools/ 下的运维脚本是纯 Node ESM（无 TS 解析器，也就没有自动注入的全局）
  {
    files: ['tools/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
);
