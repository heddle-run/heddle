import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/portable.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  noExternal: ['agentspec'],
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
  },
});
