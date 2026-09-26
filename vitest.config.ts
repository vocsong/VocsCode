import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The web shell (src/web) imports the renderer core and shared modules by alias, like its
    // vite.config.web.ts build; tests import src/web directly, so vitest needs the same mapping.
    alias: {
      '@web': resolve('src/web'),
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
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
