import { defineDocs, defineConfig } from "fumadocs-mdx/config";

export const docs = defineDocs({
  dir: "content/docs",
});

/**
 * Both shiki themes are dark, on purpose.
 *
 * fumadocs ships a light/dark pair and swaps them with the site theme. The
 * design system says code is always in navy windows that stay dark in both
 * themes — the hero, the playground and the docs all read the same way — so a
 * light theme here would be the one place code went pale. `github-dark` is the
 * closest neutral to the navy the windows are painted in.
 */
export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: { light: "github-dark", dark: "github-dark" },
    },
  },
});
