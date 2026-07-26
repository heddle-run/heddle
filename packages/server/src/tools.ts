import type { Registry, ToolDef } from '@heddle/core';
import { HttpError } from './errors.js';

/**
 * One registry over several, later sources shadowing earlier ones.
 *
 * The server can have two sources of tools at once: the executables it was
 * started with, and the scripts a request submitted. Callers pass the
 * server's first and the request's second, so a submitted tool shadows a
 * server-provided one of the same name. That direction is the predictable one
 * for a playground — a tool you just wrote is the tool that runs — and it
 * gives away nothing, since a flow that wanted the server's tool could simply
 * not have submitted one under that name.
 */
export function mergeRegistries(...registries: Registry[]): Registry {
  if (registries.length === 1) return registries[0];

  const tools = new Map<string, ToolDef>();
  for (const registry of registries) {
    for (const tool of registry.all()) {
      tools.set(tool.name, tool);
    }
  }

  return {
    lookup: (name) => tools.get(name),
    all: () => [...tools.values()],
  };
}

/**
 * Check every tool the flow names has an implementation.
 *
 * `FileRegistry.validateTools` does this for a single directory; this works
 * against the `Registry` interface so it covers a merged one too. A flow naming
 * a tool the server cannot provide is a mismatch the caller can act on, so it
 * is a 400 rather than a failure partway through the run.
 */
export function assertToolsAvailable(registry: Registry, names: string[]): void {
  const missing = names.filter((name) => !registry.lookup(name));
  if (missing.length > 0) {
    throw new HttpError(
      400,
      `missing executables for tools: ${missing.join(', ')}`,
      'ToolError',
    );
  }
}
