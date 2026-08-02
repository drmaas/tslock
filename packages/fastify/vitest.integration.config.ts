import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/*.integration.test.ts'],
    environment: 'node',
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
