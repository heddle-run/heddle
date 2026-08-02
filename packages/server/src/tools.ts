import {
  assertToolsAvailable as coreAssertToolsAvailable,
  ToolError,
  type Registry,
} from '@heddle-run/core';
import { HttpError } from './errors.js';

/**
 * Core's check, relabelled: a flow naming a tool this server does not have is
 * the caller's 400, not the 500 a `ToolError` maps to everywhere else.
 */
export function assertToolsAvailable(
  registry: Registry,
  names: string[],
): void {
  try {
    coreAssertToolsAvailable(registry, names);
  } catch (err) {
    if (err instanceof ToolError) {
      throw new HttpError(400, err.message, 'ToolError');
    }
    throw err;
  }
}
