import { readdirSync, statSync, type Stats } from 'node:fs';
import { join, extname } from 'node:path';
import type { Registry, ToolDef } from './types.js';
import { ToolError } from '../errors.js';

const EXECUTABLE_BITS = 0o111;

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

export function missingTools(registry: Registry, names: string[]): string[] {
  return names.filter((name) => !registry.lookup(name));
}

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
