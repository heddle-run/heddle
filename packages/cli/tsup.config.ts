import { defineConfig } from 'tsup';

export default defineConfig({
  // `index.ts` is the library entry (exports the commander program, no side
  // effects). `specrun.ts` is the bin entry: it has a shebang and parses argv,
  // so it must never be the module anyone imports.
  entry: ['src/index.ts', 'src/specrun.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // @specrun/core is a published dependency and must stay external.
  external: ['@specrun/core'],
  // agentspec is vendored rather than published, so it has to be bundled.
  noExternal: ['agentspec'],
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
  },
});
