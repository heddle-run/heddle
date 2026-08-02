import { readdirSync, statSync, type Stats } from 'node:fs';
import { join, extname } from 'node:path';
import type { Registry, ToolDef } from './types.js';
import { ToolError } from '../errors.js';

const EXECUTABLE_BITS = 0o111;

/**
 * The registry behind `--tools-dir`: every executable file in one directory,
 * each a tool named after its file with the extension dropped.
 *
 * The directory is scanned once, at `create` — a file added afterwards is not
 * a tool until a new registry is built, which is why a long-lived server scans
 * per run or holds one registry deliberately. Descriptions and schemas are a
 * manifest concept; a file has neither, so what the model is told about one of
 * these tools is its name and nothing more.
 */
export class FileRegistry implements Registry {
  private readonly tools: Map<string, ToolDef>;

  private constructor(tools: Map<string, ToolDef>) {
    this.tools = tools;
  }

  static create(toolsDir: string): FileRegistry {
    if (!toolsDir) return new FileRegistry(new Map());

    assertIsDirectory(toolsDir);
    return new FileRegistry(discoverExecutables(toolsDir));
  }

  lookup(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef[] {
    return [...this.tools.values()];
  }

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
 * The names a flow uses that this registry cannot serve — what to check before
 * a run rather than during one, so a missing executable is an error naming
 * every absent tool instead of a failure at whichever call reached it first.
 */
export function missingTools(registry: Registry, names: string[]): string[] {
  return names.filter((name) => !registry.lookup(name));
}

/**
 * Layer registries into one, later sources winning on a shared name.
 *
 * The order is the policy: `standardRegistry` puts the plugins' tools first
 * and the operator's directory after, so a file the operator installed shadows
 * a plugin's tool rather than the reverse. A plugin capturing a name it did
 * not declare `shadows: true` for is refused outright — a name bound in bulk
 * is reached by code that never mentions it, so heddle will not pick a winner
 * quietly. `onShadow` hears about the collisions that are allowed to stand.
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

function assertIsDirectory(toolsDir: string): void {
  let info: Stats;
  try {
    info = statSync(toolsDir);
  } catch (err) {
    throw new ToolError(`tools directory "${toolsDir}" not accessible`, {
      cause: err,
    });
  }
  if (!info.isDirectory()) {
    throw new ToolError(`"${toolsDir}" is not a directory`);
  }
}

function discoverExecutables(toolsDir: string): Map<string, ToolDef> {
  const tools = new Map<string, ToolDef>();

  for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;

    const path = join(toolsDir, entry.name);
    if (!isExecutable(path)) continue;

    const name = stripExtension(entry.name);
    tools.set(name, {
      name,
      description: '',
      impl: { kind: 'path', path },
      origin: `dir:${toolsDir}`,
    });
  }

  return tools;
}

function isExecutable(path: string): boolean {
  try {
    return (statSync(path).mode & EXECUTABLE_BITS) !== 0;
  } catch {
    return false;
  }
}

function stripExtension(fileName: string): string {
  const extension = extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

function refuseQuietCapture(tool: ToolDef, shadowed: ToolDef): void {
  const offender = undeclaredPluginTool(tool) ?? undeclaredPluginTool(shadowed);
  if (!offender) return;

  throw new ToolError(
    `two sources provide the tool "${tool.name}": ${tool.origin ?? 'one'} and ` +
      `${shadowed.origin ?? 'another'}. A plugin binds tool names in bulk and a name ` +
      `bound that way is reached by code that never mentions it, so heddle will not ` +
      `pick one quietly. Rename it in the manifest, or declare "shadows": true there ` +
      `to say the collision is intended.`,
  );
}

function undeclaredPluginTool(tool: ToolDef): ToolDef | undefined {
  const undeclared = tool.impl.kind === 'plugin' && tool.shadows !== true;
  return undeclared ? tool : undefined;
}
