import { composeRegistries, missingTools, type Registry } from '@heddle/core';
import { HttpError } from './errors.js';

export function mergeRegistries(...registries: Registry[]): Registry {
  return composeRegistries(registries);
}

export function assertToolsAvailable(
  registry: Registry,
  names: string[],
): void {
  const missing = missingTools(registry, names);
  if (missing.length > 0) {
    throw new HttpError(
      400,
      `missing executables for tools: ${missing.join(', ')}`,
      'ToolError',
    );
  }
}
