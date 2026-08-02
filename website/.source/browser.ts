// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"cli-reference.mdx": () => import("../content/docs/cli-reference.mdx?collection=docs"), "flows.mdx": () => import("../content/docs/flows.mdx?collection=docs"), "getting-started.mdx": () => import("../content/docs/getting-started.mdx?collection=docs"), "index.mdx": () => import("../content/docs/index.mdx?collection=docs"), "library.mdx": () => import("../content/docs/library.mdx?collection=docs"), "llm-providers.mdx": () => import("../content/docs/llm-providers.mdx?collection=docs"), "nodes.mdx": () => import("../content/docs/nodes.mdx?collection=docs"), "sandboxing.mdx": () => import("../content/docs/sandboxing.mdx?collection=docs"), "server.mdx": () => import("../content/docs/server.mdx?collection=docs"), "sessions.mdx": () => import("../content/docs/sessions.mdx?collection=docs"), "tools.mdx": () => import("../content/docs/tools.mdx?collection=docs"), "plugins/authoring.mdx": () => import("../content/docs/plugins/authoring.mdx?collection=docs"), "plugins/encoders.mdx": () => import("../content/docs/plugins/encoders.mdx?collection=docs"), "plugins/index.mdx": () => import("../content/docs/plugins/index.mdx?collection=docs"), "plugins/manifest.mdx": () => import("../content/docs/plugins/manifest.mdx?collection=docs"), "plugins/middleware.mdx": () => import("../content/docs/plugins/middleware.mdx?collection=docs"), }),
};
export default browserCollections;