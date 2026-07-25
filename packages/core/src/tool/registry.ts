import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { ToolDef, Registry } from './types.js';
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
        description: '',
        path,
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
    const missing: string[] = [];
    for (const name of toolNames) {
      if (!this.tools.has(name)) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      throw new ToolError(
        `missing executables for tools: ${missing.join(', ')}`,
      );
    }
  }
}
