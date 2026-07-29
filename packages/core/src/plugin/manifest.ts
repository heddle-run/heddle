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
import {
  isPluginCapability,
  PLUGIN_CAPABILITIES,
  type PluginCapability,
} from './protocol.js';
import {
  readSubscription,
  type SeamSubscription,
} from './seams.js';
import type { PluginIO } from './types.js';

/** A JSON Schema fragment. Not validated structurally — Ajv is not a dependency. */
export type JsonSchemaFragment = Record<string, unknown>;

/** One component type a plugin provides. */
export interface ManifestComponent {
  /** The `component_type` string as it appears in a spec file. */
  componentType: string;
  /** What this is, which decides how heddle treats it. Defaults to `node`. */
  kind?: 'node' | 'transform' | 'component' | 'middleware';
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
  /**
   * For middleware: which seams this subscribes to, and which halves of each.
   *
   * Declared rather than discovered, for the same reason `inputs` and `branches`
   * are: heddle has to know before the process starts. A chain that learned its
   * subscribers by calling them would spend a round trip per node per middleware
   * finding out that most of them have nothing to say — on the failure path,
   * which is exactly where a run can least afford it.
   *
   * Required for a middleware and forbidden on every other kind, so `seams` on a
   * node is a load-time error rather than a field that silently does nothing.
   */
  seams?: SeamSubscription;
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
  /**
   * The reverse calls this plugin intends to make, as a request.
   *
   * A manifest asks; the host decides — see `loadRemotePlugin`. Absent means
   * the plugin asks for nothing, and a plugin that asks for nothing gets
   * nothing: `runTool` is available because a manifest names it, not because
   * heddle happens to serve it. That default is what makes the next capability
   * safe to add, since a plugin written before it existed cannot acquire it by
   * being run on a newer heddle.
   *
   * Every reverse call is here, including the ones that only *say* something.
   * `emitEvent` and `log` look harmless next to running a tool, and they are
   * gated all the same, because what they reach is somebody's screen: an
   * operator who streams runs somewhere other than back to the caller who
   * started them has an audience the plugin did not come with. Gating is also
   * what makes the set derivable — `PluginCapability` is `PluginMethod`, so a
   * verb that needed no declaration would be a hole in that rule rather than an
   * exception to it.
   *
   * Always an array once validated, empty where the manifest said nothing, so
   * callers never have to distinguish "asked for none" from "did not say".
   */
  capabilities: PluginCapability[];
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

  const capabilities = asCapabilities(manifest.name, manifest.capabilities);

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
    if (kind !== 'node' && kind !== 'transform' && kind !== 'component' && kind !== 'middleware') {
      fail(
        `plugin "${manifest.name}": component "${componentType}" has kind "${String(kind)}"; expected node, transform, component or middleware`,
      );
    }

    const phase = component.phase;
    if (phase !== undefined && phase !== 'pre' && phase !== 'post' && phase !== 'both') {
      fail(
        `plugin "${manifest.name}": component "${componentType}" has phase "${String(phase)}"; expected pre, post or both`,
      );
    }

    const seams = asSeams(manifest.name as string, componentType, kind, component.seams);

    return {
      componentType,
      kind,
      inputs: asIo(manifest.name as string, componentType, 'inputs', component.inputs),
      outputs: asIo(manifest.name as string, componentType, 'outputs', component.outputs),
      branches: asBranches(manifest.name as string, componentType, component.branches),
      schema: component.schema as JsonSchemaFragment | undefined,
      phase: phase as ManifestComponent['phase'],
      seams,
    };
  });

  return {
    name: manifest.name,
    version: manifest.version,
    command: manifest.command as string[] | undefined,
    capabilities,
    components,
  };
}

/**
 * Check a manifest's `capabilities` against the closed set heddle serves.
 *
 * Same treatment as `kind`, and for the same reason: a name heddle does not
 * recognize is caught here, where it can be reported next to the plugin that
 * wrote it, rather than becoming a call refused mid-run that reads as a bug in
 * the plugin's own logic. Misspelling a capability is the most likely way to
 * get one, so the error lists what exists.
 */
function asCapabilities(plugin: string, value: unknown): PluginCapability[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(`plugin "${plugin}": "capabilities" must be an array of strings`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || !isPluginCapability(entry)) {
      fail(
        `plugin "${plugin}" requests capability ${JSON.stringify(entry)}, ` +
          `which heddle does not serve. It serves: ${PLUGIN_CAPABILITIES.join(', ')}.`,
      );
    }
    return entry;
  });
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

/**
 * Read a middleware's `seams`.
 *
 * The subscription itself is checked by {@link readSubscription}, which every
 * path shares — a manifest is not the only way one arrives, and a rule enforced
 * on the out-of-process path alone would be a rule an in-process author never
 * meets. What is manifest-specific and stays here is the one refusal that is
 * about `kind`: a node or a transform declaring `seams` has misunderstood which
 * kind it is, and no in-process def can express that mistake because the field
 * only exists on the middleware type.
 */
function asSeams(
  plugin: string,
  componentType: string,
  kind: string,
  value: unknown,
): SeamSubscription | undefined {
  const where = `plugin "${plugin}": ${componentType}`;

  if (kind !== 'middleware') {
    if (value !== undefined) {
      fail(
        `${where} declares "seams" but its kind is "${kind}". Only a middleware ` +
          `subscribes to a seam; every other kind is named by the spec instead.`,
      );
    }
    return undefined;
  }

  return readSubscription(where, value);
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
