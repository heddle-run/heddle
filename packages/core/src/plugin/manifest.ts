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
import { PROTOCOL_NAME } from './encoder.js';
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
  kind?:
    | 'node'
    | 'transform'
    | 'component'
    | 'provider'
    | 'middleware'
    | 'encoder';
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
   * For providers: whether this one can deliver an answer as it arrives.
   *
   * Declared rather than negotiated, for the reason every other manifest field
   * is: `completeChat` decides whether to stream by checking for
   * `Provider.chatCompletionStream`, synchronously, before the process is
   * necessarily even running. So the answer has to be data, and it is this.
   *
   * Off by default, which is the safe direction. A provider that says nothing
   * is only ever sent `stream: false` and never has to handle a mode it did not
   * implement; one that declares it and then buffers internally is killed by
   * its own silence budget, since only a partial restarts the clock.
   */
  stream?: boolean;
  /**
   * For encoders: the name a request asks for, e.g. `ag-ui`.
   *
   * Required for an encoder and forbidden on every other kind, like `seams` and
   * for the same reason — a `protocol` on a node is a misunderstanding about
   * which kind it is, and read as a field that silently does nothing it would
   * leave an author believing their format was selectable.
   */
  protocol?: string;
  /**
   * For encoders: the content type of the response this one produces.
   *
   * Required alongside `protocol`, because it is not derivable from it. Two
   * encoders can share a carrier — heddle's own frames and AG-UI's are both
   * `text/event-stream` — so the protocol name says which rendering and this
   * says what to put in the header.
   */
  contentType?: string;
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
  /**
   * Tools this plugin contributes to the flow's registry.
   *
   * Declared, never discovered — the same trick as `inputs` and `seams`, and
   * here it buys the property the whole tool layer rests on: `Registry.lookup`
   * is synchronous, called during execution and again when the server checks a
   * request, and a synchronous call cannot cross a pipe. Data in the manifest
   * is the only shape that answers "does this tool exist" without starting
   * anything.
   *
   * A tool an MCP proxy fronts is therefore written down too, by a build step
   * that talks to the server once and commits the result. That is a real cost —
   * a tool added upstream is invisible until someone reruns it — and it is the
   * one that keeps `heddle validate` honest and free.
   *
   * Always an array once validated, empty where the manifest said nothing.
   */
  tools: ManifestTool[];
}

/**
 * One tool a plugin contributes.
 *
 * `path` and `componentType` are the two ways a tool can exist and exactly one
 * must be given. `path` is an executable the plugin ships beside itself, and
 * from there nothing is different — the subprocess executor spawns it, the
 * sandbox binds it, and no consumer can tell it from a `--tools-dir` tool.
 * `componentType` means the plugin implements it, and running it is a call back
 * into the plugin's own process.
 */
export interface ManifestTool {
  name: string;
  description?: string;
  /** An executable shipped with the plugin, resolved against its directory. */
  path?: string;
  /** The component in this plugin that implements it. */
  componentType?: string;
  inputSchema?: JsonSchemaFragment;
  outputSchema?: JsonSchemaFragment;
  /**
   * Whether this tool may take a name another source already provides.
   *
   * Off by default, and the default is the point. Today's shadowing rule was
   * written about tool *scripts* a caller submits alongside their flow — one
   * person overriding a name they typed themselves, in a document they can read
   * back. A manifest is bulk, and a name a caller never wrote can capture calls
   * made by code they did not write either: an operator's middleware resolves
   * `runTool` against the registry and never against the spec. So a collision
   * is a load error unless somebody says otherwise in writing, and the server
   * refuses to let a submitted plugin be that somebody.
   */
  shadows?: boolean;
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
  const declaresTools = Array.isArray(manifest.tools) && manifest.tools.length > 0;
  // A tools-only plugin is a real shape and the point of the kind: an MCP proxy
  // contributes no node, no transform and no middleware — it contributes tools.
  // Refusing it for declaring no components would make the manifest half of
  // this feature unreachable.
  if (
    !declaresTools &&
    (!Array.isArray(manifest.components) || manifest.components.length === 0)
  ) {
    fail(`plugin "${manifest.name}" manifest declares no components and no tools`);
  }
  if (manifest.components !== undefined && !Array.isArray(manifest.components)) {
    fail(`plugin "${manifest.name}" manifest has a "components" that is not an array`);
  }
  const rawComponents = (manifest.components ?? []) as unknown[];

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
  const components = rawComponents.map((entry): ManifestComponent => {
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
    if (
      kind !== 'node' &&
      kind !== 'transform' &&
      kind !== 'component' &&
      kind !== 'provider' &&
      kind !== 'middleware' &&
      kind !== 'encoder'
    ) {
      fail(
        `plugin "${manifest.name}": component "${componentType}" has kind "${String(kind)}"; expected node, transform, component, provider, middleware or encoder`,
      );
    }

    const phase = component.phase;
    if (phase !== undefined && phase !== 'pre' && phase !== 'post' && phase !== 'both') {
      fail(
        `plugin "${manifest.name}": component "${componentType}" has phase "${String(phase)}"; expected pre, post or both`,
      );
    }

    if (component.stream !== undefined && typeof component.stream !== 'boolean') {
      fail(
        `plugin "${manifest.name}": component "${componentType}" has a "stream" that is not a boolean`,
      );
    }

    const seams = asSeams(manifest.name as string, componentType, kind, component.seams);
    const rendering = asRendering(manifest.name as string, componentType, kind, component);

    return {
      componentType,
      kind,
      inputs: asIo(manifest.name as string, componentType, 'inputs', component.inputs),
      outputs: asIo(manifest.name as string, componentType, 'outputs', component.outputs),
      branches: asBranches(manifest.name as string, componentType, component.branches),
      schema: component.schema as JsonSchemaFragment | undefined,
      phase: phase as ManifestComponent['phase'],
      stream: component.stream === true,
      seams,
      protocol: rendering?.protocol,
      contentType: rendering?.contentType,
    };
  });

  return {
    name: manifest.name,
    version: manifest.version,
    command: manifest.command as string[] | undefined,
    capabilities,
    components,
    tools: asTools(manifest.name, manifest.tools, seen),
  };
}

/**
 * Read a manifest's `tools`, refusing what would fail later or silently.
 *
 * The name rule is the strictest thing here and it is not arbitrary: a tool's
 * name is what a spec writes, what the model is told, and what `runTool`
 * resolves — so it lives in the same namespace `collectToolNames` reads and has
 * to be as ordinary as a filename was. `path` and `componentType` are exclusive
 * because they are two different answers to "how does this run", and a tool
 * carrying both would leave the precedence to whoever wrote the dispatch.
 *
 * A `componentType` is checked against the components this same manifest
 * declares, which is why `seen` is threaded in — a tool naming a component the
 * plugin does not provide is a typo that would otherwise surface as a failed
 * call, mid-run, from another process.
 */
function asTools(
  plugin: string,
  value: unknown,
  components: Set<string>,
): ManifestTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(`plugin "${plugin}": "tools" must be an array`);
  }

  const seen = new Set<string>();
  return value.map((entry): ManifestTool => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(`plugin "${plugin}": each entry in "tools" must be an object`);
    }
    const tool = entry as Record<string, unknown>;

    if (typeof tool.name !== 'string' || !NAME.test(tool.name)) {
      fail(
        `plugin "${plugin}": a tool's "name" must match ${NAME.source}, got ` +
          `${JSON.stringify(tool.name)}. It is what a spec writes and what the model ` +
          `is told, so it lives in the same namespace a tool file's name does.`,
      );
    }
    if (seen.has(tool.name)) {
      fail(`plugin "${plugin}" declares the tool "${tool.name}" twice`);
    }
    seen.add(tool.name);

    const hasPath = tool.path !== undefined;
    const hasComponent = tool.componentType !== undefined;
    if (hasPath === hasComponent) {
      fail(
        `plugin "${plugin}": tool "${tool.name}" must have exactly one of "path" — an ` +
          `executable shipped beside the plugin — or "componentType", naming the ` +
          `component in this plugin that implements it. ` +
          `${hasPath ? 'It has both.' : 'It has neither.'}`,
      );
    }
    if (hasPath && (typeof tool.path !== 'string' || tool.path.length === 0)) {
      fail(`plugin "${plugin}": tool "${tool.name}" has a "path" that is not a string`);
    }
    if (hasComponent) {
      if (typeof tool.componentType !== 'string' || !components.has(tool.componentType)) {
        fail(
          `plugin "${plugin}": tool "${tool.name}" names componentType ` +
            `${JSON.stringify(tool.componentType)}, which this plugin does not declare. ` +
            `It declares: ${components.size > 0 ? [...components].join(', ') : 'nothing'}.`,
        );
      }
    }
    if (tool.description !== undefined && typeof tool.description !== 'string') {
      fail(`plugin "${plugin}": tool "${tool.name}" has a "description" that is not a string`);
    }
    if (tool.shadows !== undefined && typeof tool.shadows !== 'boolean') {
      fail(`plugin "${plugin}": tool "${tool.name}" has a "shadows" that is not a boolean`);
    }
    checkToolSchema(plugin, tool.name, 'inputSchema', tool.inputSchema);
    checkToolSchema(plugin, tool.name, 'outputSchema', tool.outputSchema);

    return {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : undefined,
      path: hasPath ? (tool.path as string) : undefined,
      componentType: hasComponent ? (tool.componentType as string) : undefined,
      inputSchema: tool.inputSchema as JsonSchemaFragment | undefined,
      outputSchema: tool.outputSchema as JsonSchemaFragment | undefined,
      shadows: tool.shadows === true,
    };
  });
}

/**
 * The bytes and the depth of a schema a plugin wrote.
 *
 * An `inputSchema` is the one thing a plugin supplies that reaches the model's
 * own tool block verbatim, in the position a model trusts most. The cap is not
 * about the model, though — it is about the two things in between: this whole
 * object is serialized into every request of every round, and `checkSchema`
 * walks it. A schema nobody bounded is a plugin choosing how large heddle's
 * requests are.
 */
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 16;

function checkToolSchema(
  plugin: string,
  tool: string,
  field: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`plugin "${plugin}": tool "${tool}" has a "${field}" that is not a JSON Schema object`);
  }

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    fail(`plugin "${plugin}": tool "${tool}" has a "${field}" that is not JSON: ${String(err)}`);
  }
  if (json.length > MAX_SCHEMA_BYTES) {
    fail(
      `plugin "${plugin}": tool "${tool}" has a "${field}" of ${json.length} bytes, over ` +
        `heddle's ${MAX_SCHEMA_BYTES}. It is sent to the model on every round of every ` +
        `turn, so its size is a cost the flow pays repeatedly.`,
    );
  }
  // A tool's parameters are an object of named arguments — that is what the
  // model's tool block means and what `parseToolArguments` refuses anything
  // else for. A schema saying otherwise describes a call heddle would reject
  // after the model made it.
  const declared = (value as Record<string, unknown>).type;
  if (declared !== undefined && declared !== 'object') {
    fail(
      `plugin "${plugin}": tool "${tool}" has a "${field}" of type ` +
        `${JSON.stringify(declared)}. A tool takes an object of named arguments, so ` +
        `its schema has to describe one.`,
    );
  }
  if (depthOf(value) > MAX_SCHEMA_DEPTH) {
    fail(
      `plugin "${plugin}": tool "${tool}" has a "${field}" nested deeper than ` +
        `${MAX_SCHEMA_DEPTH} levels.`,
    );
  }
}

function depthOf(value: unknown, depth = 1): number {
  if (typeof value !== 'object' || value === null) return depth;
  let deepest = depth;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepest = Math.max(deepest, depthOf(nested, depth + 1));
  }
  return deepest;
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

/**
 * Read an encoder's `protocol` and `contentType`, and refuse them on any other
 * kind.
 *
 * The shape of the protocol name is checked here as well as in
 * `PluginRegistry.claimProtocol`, and the duplication is the same one `seams`
 * has: the registry's check is the one every path shares, including the
 * in-process API, and this one exists so the error names the manifest and the
 * component that wrote it. What is manifest-specific and could not live in the
 * registry is the refusal below — an in-process def cannot express "a node with
 * a protocol", because the field only exists on the encoder type.
 */
function asRendering(
  plugin: string,
  componentType: string,
  kind: string,
  component: Record<string, unknown>,
): { protocol: string; contentType: string } | undefined {
  const where = `plugin "${plugin}": ${componentType}`;

  if (kind !== 'encoder') {
    for (const field of ['protocol', 'contentType'] as const) {
      if (component[field] !== undefined) {
        fail(
          `${where} declares "${field}" but its kind is "${kind}". Only an encoder ` +
            `renders the run for a client; every other kind is named by the spec or ` +
            `installed by the operator.`,
        );
      }
    }
    return undefined;
  }

  const protocol = component.protocol;
  if (typeof protocol !== 'string' || !PROTOCOL_NAME.test(protocol)) {
    fail(
      `${where} is an encoder, so it needs a "protocol" matching ` +
        `${PROTOCOL_NAME.source} — the name a client puts in "?protocol=" to ask ` +
        `for this rendering. Got ${JSON.stringify(protocol)}.`,
    );
  }
  const contentType = component.contentType;
  if (typeof contentType !== 'string' || !contentType) {
    fail(
      `${where} is an encoder, so it needs a "contentType" — the content type of ` +
        `the response it produces. Use "text/event-stream" for a protocol carried ` +
        `over SSE. Got ${JSON.stringify(contentType)}.`,
    );
  }

  return { protocol, contentType };
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
