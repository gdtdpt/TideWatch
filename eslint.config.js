import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 插件是独立进程的产物（Python 依赖 21MB 预装），不在本仓库 lint 范围内
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'plugins/**'] },
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
);
