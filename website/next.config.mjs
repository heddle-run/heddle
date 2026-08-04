import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const nextConfig = {
  output: "export",

  /**
   * Let this site import heddle's own TypeScript source.
   *
   * `lib/library.ts` reads each entry's `requires` with `packages/core`'s
   * parser rather than a second copy of the rules, so what a library page says
   * an entry needs is what `heddle run` will check for. Core is written as
   * TypeScript ESM — its internal imports name `./errors.js` for a file called
   * `errors.ts` — and webpack resolves that spelling only when told how. The
   * `.js` fallback is kept last so nothing that already resolved changes.
   *
   * The website is not in the pnpm workspace and depends on no heddle package
   * (it is deployed by `npm ci` in this directory alone), so the source tree in
   * the same checkout is what there is to share. This is the seam that keeps
   * the docs and the runtime from drifting.
   */
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default withMDX(nextConfig);
