import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Registry, ToolDef } from './types.js';
import { ToolError } from '../errors.js';

/** FileRegistry discovers tools from a directory of executables. */
export class FileRegistry implements Registry {
  private tools: Map<string, ToolDef>;

  private constructor(tools: Map<string, ToolDef>) {
    this.tools = tools;
  }

  /** Creates a registry by scanning the given directory for executables. */
  static create(toolsDir: string): FileRegistry {
    const tools = new Map<string, ToolDef>();

    if (!toolsDir) {
      return new FileRegistry(tools);
    }

    let info;
    try {
      info = statSync(toolsDir);
    } catch (err) {
      throw new ToolError(`tools directory "${toolsDir}" not accessible`, { cause: err });
    }
    if (!info.isDirectory()) {
      throw new ToolError(`"${toolsDir}" is not a directory`);
    }

    const entries = readdirSync(toolsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) continue;

      const path = join(toolsDir, entry.name);
      let entryInfo;
      try {
        entryInfo = statSync(path);
      } catch {
        continue;
      }

      // Check if executable
      if ((entryInfo.mode & 0o111) === 0) continue;

      // Strip extension to get tool name
      const ext = extname(entry.name);
      const name = ext ? entry.name.slice(0, -ext.length) : entry.name;

      tools.set(name, {
        name,
        // Still empty, and now it matters less: a spec that says nothing about
        // a tool falls back to the registry's description, so a source that has
        // one can supply it. A directory of executables is not such a source —
        // there is nowhere in a filename to put a sentence.
        description: '',
        impl: { kind: 'path', path },
        origin: `dir:${toolsDir}`,
      });
    }

    return new FileRegistry(tools);
  }

  lookup(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef[] {
    return Array.from(this.tools.values());
  }

  /** Checks that all tool names in the spec have matching executables. */
  validateTools(toolNames: string[]): void {
    const missing = missingTools(this, toolNames);
    if (missing.length > 0) {
      throw new ToolError(
        `missing executables for tools: ${missing.join(', ')}`,
      );
    }
  }
}

/**
 * Refuse a collision that involves a plugin, in either direction.
 *
 * Order decides who wins a name, and for two sources somebody typed out — a
 * tools directory and a request's own scripts — that is fine, because the
 * person who chose the order also wrote both names. A manifest is different in
 * kind: it binds names in bulk, and a name it binds can be reached by code that
 * never mentions it, since a plugin's `runTool` and an operator's middleware
 * both resolve against this registry rather than against any document. Losing
 * the name matters as much as taking it, so this fires either way.
 *
 * `shadows: true` is the manifest saying it knows. The server refuses that from
 * a submitted plugin, so the only party who can say it is the operator.
 */
function refuseQuietCapture(tool: ToolDef, shadowed: ToolDef): void {
  const offender =
    tool.impl.kind === 'plugin' && tool.shadows !== true
      ? tool
      : shadowed.impl.kind === 'plugin' && shadowed.shadows !== true
        ? shadowed
        : undefined;
  if (!offender) return;

  throw new ToolError(
    `two sources provide the tool "${tool.name}": ${tool.origin ?? 'one'} and ` +
      `${shadowed.origin ?? 'another'}. A plugin binds tool names in bulk and a name ` +
      `bound that way is reached by code that never mentions it, so heddle will not ` +
      `pick one quietly. Rename it in the manifest, or declare "shadows": true there ` +
      `to say the collision is intended.`,
  );
}

/**
 * Which of these names no source provides.
 *
 * Here rather than in each caller because there are now three — this class, the
 * CLI, and the server's `assertToolsAvailable` — and two of them were checking
 * the wrong registry. `heddle run` validated against the `FileRegistry` alone,
 * so a flow naming a tool a plugin supplies was reported missing before the run
 * that would have found it. The name of the check is the whole of what differs
 * between the callers; the answer is one function.
 */
export function missingTools(registry: Registry, names: string[]): string[] {
  return names.filter((name) => !registry.lookup(name));
}

/**
 * One registry over several, later sources shadowing earlier ones.
 *
 * Moved here from the server, which had to write it outside core because core
 * offered nothing — and which is no longer the only host that needs it: the CLI
 * now has two sources too, a tools directory and whatever its plugins declare.
 *
 * **Later wins, and the argument order is the caller's policy.** Core cannot
 * make that decision because it does not know which of its callers is the
 * operator: on the server a submitted tool shadowing a server-provided one is
 * the playground working as intended, and on the CLI a directory the operator
 * typed on this command line beating an installed plugin is the same instinct
 * pointing the other way. What core can do is refuse to let a shadowing pass
 * unnoticed, which is what `onShadow` is for.
 */
export function composeRegistries(
  registries: Registry[],
  onShadow?: (tool: ToolDef, shadowed: ToolDef) => void,
): Registry {
  if (registries.length === 1) return registries[0];

  const tools = new Map<string, ToolDef>();
  for (const registry of registries) {
    for (const tool of registry.all()) {
      const shadowed = tools.get(tool.name);
      if (shadowed) {
        refuseQuietCapture(tool, shadowed);
        onShadow?.(tool, shadowed);
      }
      tools.set(tool.name, tool);
    }
  }

  return {
    lookup: (name) => tools.get(name),
    all: () => [...tools.values()],
  };
}
