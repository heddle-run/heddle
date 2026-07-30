// @ts-nocheck
import * as __fd_glob_14 from "../content/docs/plugins/middleware.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/plugins/manifest.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/plugins/index.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/plugins/encoders.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/plugins/authoring.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/tools.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/nodes.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/llm-providers.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/index.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/getting-started.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/flows.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/comparison.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/cli-reference.mdx?collection=docs"
import { default as __fd_glob_1 } from "../content/docs/plugins/meta.json?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, "plugins/meta.json": __fd_glob_1, }, {"cli-reference.mdx": __fd_glob_2, "comparison.mdx": __fd_glob_3, "flows.mdx": __fd_glob_4, "getting-started.mdx": __fd_glob_5, "index.mdx": __fd_glob_6, "llm-providers.mdx": __fd_glob_7, "nodes.mdx": __fd_glob_8, "tools.mdx": __fd_glob_9, "plugins/authoring.mdx": __fd_glob_10, "plugins/encoders.mdx": __fd_glob_11, "plugins/index.mdx": __fd_glob_12, "plugins/manifest.mdx": __fd_glob_13, "plugins/middleware.mdx": __fd_glob_14, });