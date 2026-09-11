import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    // Force NODE_ENV=test: React's production build (used when the environment exports
    // NODE_ENV=production) has no act(), which breaks component tests.
    env: { NODE_ENV: 'test' },
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
});
