import { readFileSync } from 'node:fs';
import { PluginError } from '../errors.js';

const FILE_PREFIX = '@';
const FLAG = '--plugin-config';

/**
 * Read `--plugin-config <ComponentType>=<json>` into settings by component type.
 *
 * Shared by `heddle run` and `heddle-server` because it is the same flag on
 * both, for the same reason: a middleware is chosen by whoever runs heddle, so
 * its settings arrive on the command line rather than in the document that
 * names it — nothing names it.
 *
 * `@file` is not a convenience. A policy's settings are the kind of thing that
 * holds an endpoint, a budget or a list of approvers, and a command line is
 * visible in `ps` to every user on the host.
 */
export function parsePluginConfig(
  values: string[] | undefined,
): Record<string, Record<string, unknown>> {
  const config: Record<string, Record<string, unknown>> = {};

  for (const entry of values ?? []) {
    const { componentType, settings } = parseEntry(entry);
    if (config[componentType]) {
      throw new PluginError(`${FLAG} was given twice for "${componentType}"`);
    }
    config[componentType] = settings;
  }

  return config;
}

function parseEntry(entry: string): {
  componentType: string;
  settings: Record<string, unknown>;
} {
  const separator = entry.indexOf('=');
  if (separator <= 0) {
    throw new PluginError(
      `${FLAG} expects <ComponentType>=<json>, got "${entry}". ` +
        `For example: ${FLAG} RetryPolicy='{"maxAttempts":3}'`,
    );
  }

  const componentType = entry.slice(0, separator);
  const raw = entry.slice(separator + 1);
  const text = raw.startsWith(FILE_PREFIX)
    ? readConfigFile(componentType, raw.slice(FILE_PREFIX.length))
    : raw;

  return { componentType, settings: parseConfigJson(componentType, text) };
}

function readConfigFile(componentType: string, path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    throw new PluginError(
      `${FLAG} ${componentType}=@${path}: the file is not readable ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

function parseConfigJson(
  componentType: string,
  text: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PluginError(
      `${FLAG} ${componentType}: the value is not JSON ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    const got =
      parsed === null
        ? 'null'
        : Array.isArray(parsed)
          ? 'an array'
          : typeof parsed;
    throw new PluginError(
      `${FLAG} ${componentType}: expected a JSON object of settings, got ${got}`,
    );
  }

  return parsed as Record<string, unknown>;
}
