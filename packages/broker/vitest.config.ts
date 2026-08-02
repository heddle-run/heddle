import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // The tests exercise the pure logic on Node; the only Cloudflare runtime
      // import in that logic is the DurableObject base class.
      'cloudflare:workers': fileURLToPath(
        new URL('./src/__tests__/stubs/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
});
