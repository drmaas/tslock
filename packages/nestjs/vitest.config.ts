import { defineConfig } from 'vitest/config';

export default defineConfig({
  oxc: {
    decorator: {
      legacy: true,
    },
  },
  test: {
    include: ['__tests__/**/*.test.ts'],
    exclude: ['**/__tests__/*.integration.test.ts'],
    environment: 'node',
  },
});
