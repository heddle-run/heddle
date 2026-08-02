// source.config.ts
import { defineDocs, defineConfig } from "fumadocs-mdx/config";
var docs = defineDocs({
  dir: "content/docs"
});
var source_config_default = defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: { light: "github-dark", dark: "github-dark" }
    }
  }
});
export {
  source_config_default as default,
  docs
};
