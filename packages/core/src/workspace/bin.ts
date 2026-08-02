import { chmodSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Registry } from '../tool/types.js';
import type { WorkspaceTool } from './types.js';

const OWNER_READ_EXECUTE = 0o500;

/**
 * Every tool, as something a workspace can put in `bin`.
 *
 * A tool a plugin answers over its own channel has no program to link, and gets
 * a shim that says so — see {@link fillBin}. The alternative was leaving it
 * out, and `command not found` is the wrong thing to tell a model about a tool
 * that exists.
 */
export function workspaceTools(registry: Registry): WorkspaceTool[] {
  return registry.all().map((tool) => {
    switch (tool.impl.kind) {
      case 'path':
        return { name: tool.name, target: tool.impl.path };
      case 'plugin':
        return { name: tool.name, servedBy: tool.impl.plugin };
    }
  });
}

/**
 * Fill a workspace's `bin`, and report what it now points into.
 *
 * **Symlinks, not copies.** A copy would break a tool that reads a data file
 * beside itself, because `realpath(__file__)` would then land in a directory
 * holding only its siblings. The link is named after the tool's *registry*
 * name, not its filename — `read_file.py` is `read_file` — so a tool has one
 * name whether the model calls it or a shell does.
 */
export function fillBin(bin: string, tools: WorkspaceTool[]): string[] {
  const paths = new Set<string>();

  for (const tool of tools) {
    const link = join(bin, tool.name);

    if (tool.target !== undefined) {
      const real = realpathSync(tool.target);
      symlinkSync(real, link);
      paths.add(dirname(real));
      continue;
    }

    writeFileSync(link, shim(tool), { mode: OWNER_READ_EXECUTE });
    chmodSync(link, OWNER_READ_EXECUTE);
  }

  return [...paths];
}

/**
 * What a tool that is not a program leaves behind in its place.
 *
 * A plugin-served tool has no executable to link: it is answered over the
 * plugin's own channel, and a shell inside the sandbox has no way to reach
 * that. Building one would mean a socket through the confinement, which is a
 * new capability wearing a convenience's clothes.
 *
 * Silence was the alternative and is worse. `command not found` tells the model
 * the tool does not exist, and it does — it is just not a program, which is a
 * different problem with a different recovery. `bash` carries stderr and the
 * exit code straight back to the model, which is the one reader who can act on
 * either.
 */
function shim(tool: WorkspaceTool): string {
  return `#!/bin/sh
echo '${tool.name} is served by the plugin "${tool.servedBy ?? 'unknown'}" and is not a program. Call it as a tool; it cannot be run from a shell.' >&2
exit 1
`;
}
