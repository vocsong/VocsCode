import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The real relay Worker and Hub run inside workerd/Miniflare, never in the Node test pool.
export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './relay/wrangler.jsonc' },
    miniflare: { bindings: { ENROLL_TOKEN: 'relay-do-test-enroll' } }
  })],
  test: {
    include: ['relay/tests/**/*.test.ts'],
    testTimeout: 20_000
  }
});
