import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // Resolve the workspace dependency to source, so tests do not require a
      // prior build of @heddle/core.
      '@heddle/core': fileURLToPath(
        new URL('../core/src/index.ts', import.meta.url),
      ),
    },
  },
});
