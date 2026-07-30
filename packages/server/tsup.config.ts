import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/heddle-server.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['@heddle/core'],
});
