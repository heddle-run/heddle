import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `pnpm test` runs vitest per package, where each config scopes itself to
    // that package's src. A bare `vitest run <pattern>` from the repo root has
    // no such scope and falls back to globbing the whole tree, which sweeps in
    // the git worktrees the agent harness creates under .claude/ — each a full
    // copy of packages/*/src, whose stale tests fail and look like real
    // failures.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
