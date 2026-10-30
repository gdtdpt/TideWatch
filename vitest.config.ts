import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    // 首例要冷启动 fastify + 插件注册，5s 默认值不够
    testTimeout: 20_000,
  },
});
