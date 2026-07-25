import { defineConfig } from 'tsup';

export default defineConfig({
  // `index.ts` is the library entry (createServer / startServer, no side
  // effects). `heddle-server.ts` is the bin entry: it reads argv and listens.
  entry: ['src/index.ts', 'src/heddle-server.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['@heddle/core'],
});
