import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/integration/**/*.test.ts'],
    environment: 'node',
    hookTimeout: 180_000,
    testTimeout: 120_000,
  },
});
