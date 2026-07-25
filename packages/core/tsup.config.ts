import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // Bundle agentspec into dist: it is vendored, not published to npm, so it
  // cannot be resolved by consumers at runtime. See vendor/agentspec/VENDOR.md.
  noExternal: ['agentspec'],
  // The yaml package (an agentspec dependency) uses CJS require("process"),
  // which fails under ESM bundling. Provide a require shim so the bundled code
  // can resolve Node built-ins at runtime.
  banner: {
    js: `import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);`,
  },
});
