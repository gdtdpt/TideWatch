import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    // 每个测试文件是独立 worker：首例要付整个模块图的转译加载（实测 ~12s）
    // 再加 buildApp（打开库 + 迁移 + 恢复扫描，~7s）。22 个文件并行时 CPU 争抢会把它顶到 20s 以上，
    // 5s 默认值和 20s 都会偶发超时（表现为"改了一行文档，health 也说超时"）。
    testTimeout: 40_000,
  },
});
