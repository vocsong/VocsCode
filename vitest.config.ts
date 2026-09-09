import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
});
