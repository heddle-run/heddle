import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/heddle.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['@heddle-run/core'],
  noExternal: ['agentspec'],
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
  },
});
