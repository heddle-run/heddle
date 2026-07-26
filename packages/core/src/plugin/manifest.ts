/**
 * The declarative half of an out-of-process plugin.
 *
 * A plugin that runs in its own process still has to answer questions during
 * parsing and compilation — what component types does it provide, what are
 * their inputs and outputs, which branches can they take, is this spec valid.
 * The in-process API answers those with function calls. Out of process that
 * would mean either a synchronous IPC round trip inside `parseFlow`, or making
 * the whole parser async.
 *
 * So it answers them with data instead. The manifest declares everything the
 * parser and compiler need; only `execute` crosses the process boundary. Two
 * things fall out of that, and both are worth more than the flexibility lost:
 *
 * - `parseFlow` stays synchronous.
 * - A spec's shape can be inspected without executing its author's code. With
 *   the in-process API, learning what a plugin provides means importing it,
 *   which is already the whole risk.
 */
import { PluginError } from '../errors.js';
import type { PluginIO } from './types.js';

/** A JSON Schema fragment. Not validated structurally — Ajv is not a dependency. */
export type JsonSchemaFragment = Record<string, unknown>;

/** One component type a plugin provides. */
export interface ManifestComponent {
  /** The `component_type` string as it appears in a spec file. */
  componentType: string;
  /** What this is, which decides how heddle treats it. Defaults to `node`. */
  kind?: 'node' | 'transform' | 'component';
  /** Inputs to advertise when the spec file does not declare them. */
  inputs?: PluginIO[];
  /** Outputs to advertise when the spec file does not declare them. */
  outputs?: PluginIO[];
  /**
   * Branch names this component can take. Static by necessity: heddle's graph
   * validator checks reachability before anything executes, so a branch that
   * only exists at runtime would be reported as unreachable.
   */
  branches?: string[];
  /**
   * Optional JSON Schema the spec component is checked against.
   *
   * Replaces the in-process `validate()` callback. A schema is data, so it can
   * be applied during parsing without starting the plugin.
   */
  schema?: JsonSchemaFragment;
  /** For transforms: which phase(s) of an agent's turn this runs in. */
  phase?: 'pre' | 'post' | 'both';
}

/** The manifest of an out-of-process plugin. */
export interface PluginManifest {
  name: string;
  version: string;
  /**
   * How to start the plugin process, as argv. Resolved relative to the
   * plugin's own directory. When absent, the loader supplies a default for the
   * plugin's file type — a `.mjs` entry point runs under the host's node.
   */
  command?: string[];
  components: ManifestComponent[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(message: string): never {
  throw new PluginError(message);
}

/**
 * Check a manifest is well-formed.
 *
 * Deliberately strict, and deliberately not a JSON Schema validation of the
 * manifest itself: this runs against data that may have arrived in an HTTP
 * request, and the failure it produces is the first thing a plugin author sees.
 */
export function validateManifest(raw: unknown): PluginManifest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('plugin manifest must be a JSON object');
  }
  const manifest = raw as Record<string, unknown>;

  if (typeof manifest.name !== 'string' || !manifest.name) {
    fail('plugin manifest is missing a "name"');
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    fail(`plugin "${manifest.name}" manifest is missing a "version"`);
  }
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    fail(`plugin "${manifest.name}" manifest declares no components`);
  }

  if (manifest.command !== undefined) {
    if (
      !Array.isArray(manifest.command) ||
      manifest.command.length === 0 ||
      manifest.command.some((part) => typeof part !== 'string')
    ) {
      fail(`plugin "${manifest.name}" has a "command" that is not a non-empty string array`);
    }
  }

  const seen = new Set<string>();
  const components = manifest.components.map((entry): ManifestComponent => {
    if (typeof entry !== 'object' || entry === null) {
      fail(`plugin "${manifest.name}": each component must be an object`);
    }
    const component = entry as Record<string, unknown>;
    const componentType = component.componentType;

    if (typeof componentType !== 'string' || !NAME.test(componentType)) {
      fail(
        `plugin "${manifest.name}": componentType must match ${NAME.source}, got ${JSON.stringify(componentType)}`,
      );
    }
    if (seen.has(componentType)) {
      fail(`plugin "${manifest.name}" declares component type "${componentType}" twice`);
    }
    seen.add(componentType);

    const kind = component.kind ?? 'node';
    if (kind !== 'node' && kind !== 'transform' && kind !== 'component') {
      fail(
        `plugin "${manifest.name}": component "${componentType}" has kind "${String(kind)}"; expected node, transform or component`,
      );
    }

    const phase = component.phase;
    if (phase !== undefined && phase !== 'pre' && phase !== 'post' && phase !== 'both') {
      fail(
        `plugin "${manifest.name}": component "${componentType}" has phase "${String(phase)}"; expected pre, post or both`,
      );
    }

    return {
      componentType,
      kind,
      inputs: asIo(manifest.name as string, componentType, 'inputs', component.inputs),
      outputs: asIo(manifest.name as string, componentType, 'outputs', component.outputs),
      branches: asBranches(manifest.name as string, componentType, component.branches),
      schema: component.schema as JsonSchemaFragment | undefined,
      phase: phase as ManifestComponent['phase'],
    };
  });

  return {
    name: manifest.name,
    version: manifest.version,
    command: manifest.command as string[] | undefined,
    components,
  };
}

function asIo(
  plugin: string,
  componentType: string,
  field: string,
  value: unknown,
): PluginIO[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    fail(`plugin "${plugin}": ${componentType}.${field} must be an array`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      fail(`plugin "${plugin}": each entry in ${componentType}.${field} must be an object`);
    }
    const io = entry as Record<string, unknown>;
    if (typeof io.title !== 'string' || !io.title) {
      fail(`plugin "${plugin}": an entry in ${componentType}.${field} has no "title"`);
    }
    if (typeof io.type !== 'string' || !io.type) {
      fail(`plugin "${plugin}": ${componentType}.${field}."${io.title}" has no "type"`);
    }
    return {
      title: io.title,
      type: io.type,
      description: typeof io.description === 'string' ? io.description : undefined,
      default: io.default,
    };
  });
}

function asBranches(
  plugin: string,
  componentType: string,
  value: unknown,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((b) => typeof b !== 'string')) {
    fail(`plugin "${plugin}": ${componentType}.branches must be an array of strings`);
  }
  return value as string[];
}
