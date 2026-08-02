import YAML from 'yaml';
import { SpecError } from '../errors.js';
import type { PluginRegistry } from '../plugin/registry.js';

/**
 * An input wire format: one way a spec document reaches heddle as text.
 *
 * `parse` turns raw text into the one shape the rest of the pipeline consumes
 * — a plain object in Agent Spec's wire vocabulary (`component_type`,
 * snake_case keys, `$component_ref` references). Everything downstream of that
 * object — plugin checks, deserialization, graph compilation — is format-blind,
 * so a new format adapts at this seam and touches nothing else. A format whose
 * native schema is not Agent Spec translates to that vocabulary here.
 */
export interface InputFormatDef {
  /**
   * What `--format` and a request's "format" field write. Lower-case letters,
   * digits and hyphens, like an encoder's protocol name.
   */
  name: string;
  /** Extensions this format claims for path-based detection, dot included. */
  extensions: readonly string[];
  /** Raw text to an Agent Spec document. */
  parse(text: string): unknown;
}

/** The same shape a protocol name has: what a flag or a request field writes. */
export const INPUT_FORMAT_NAME = /^[a-z0-9][a-z0-9-]*$/;

export const JSON_INPUT_FORMAT: InputFormatDef = {
  name: 'json',
  extensions: ['.json'],
  parse: (text) => JSON.parse(text),
};

export const YAML_INPUT_FORMAT: InputFormatDef = {
  name: 'yaml',
  extensions: ['.yaml', '.yml'],
  parse: (text) => YAML.parse(text),
};

export const BUILTIN_INPUT_FORMATS: readonly InputFormatDef[] = [
  JSON_INPUT_FORMAT,
  YAML_INPUT_FORMAT,
];

/**
 * The format a name selects, or a refusal that lists what could have been.
 *
 * Builtins answer first: "json" and "yaml" mean the same thing whatever is
 * loaded, and the registry's own claims refuse a plugin that tries to take
 * either name, so the order here can never change an outcome.
 */
export function inputFormatByName(
  name: string,
  registry?: PluginRegistry,
): InputFormatDef {
  const builtin = BUILTIN_INPUT_FORMATS.find((format) => format.name === name);
  if (builtin) return builtin;

  const fromPlugin = registry?.inputFormatDef(name);
  if (fromPlugin) return fromPlugin;

  throw new SpecError(
    `unknown input format "${name}". Known formats: ` +
      `${knownFormatNames(registry).join(', ')}. A format beyond the ` +
      `builtins comes from a plugin that declares it.`,
  );
}

/**
 * The format a file path selects, by extension.
 *
 * Anything unclaimed falls back to JSON rather than being refused — that is
 * what heddle has always done with an extensionless or unfamiliar path, and a
 * spec piped through `/dev/stdin` or saved as `.txt` keeps working. A caller
 * that knows better says so with an explicit format name.
 */
export function inputFormatForPath(
  path: string,
  registry?: PluginRegistry,
): InputFormatDef {
  const extension = extensionOf(path);
  if (extension === undefined) return JSON_INPUT_FORMAT;

  const builtin = BUILTIN_INPUT_FORMATS.find((format) =>
    format.extensions.includes(extension),
  );
  if (builtin) return builtin;

  return registry?.inputFormatForExtension(extension) ?? JSON_INPUT_FORMAT;
}

function knownFormatNames(registry?: PluginRegistry): string[] {
  return [
    ...BUILTIN_INPUT_FORMATS.map((format) => format.name),
    ...(registry?.inputFormatNames() ?? []),
  ];
}

function extensionOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : undefined;
}
