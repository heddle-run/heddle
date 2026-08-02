import { basename } from 'node:path';
import { PluginError } from '../errors.js';
import { PROTOCOL_NAME } from './encoder.js';
import {
  isPluginMethod,
  PLUGIN_METHODS,
  type PluginMethod,
} from './protocol.js';
import { readSubscription, type SeamSubscription } from './seams.js';
import type { PluginIO } from './types.js';

export type JsonSchemaFragment = Record<string, unknown>;

export type ManifestKind =
  | 'node'
  | 'transform'
  | 'component'
  | 'provider'
  | 'middleware'
  | 'encoder'
  | 'store';

export interface ManifestComponent {
  componentType: string;
  kind?: ManifestKind;
  inputs?: PluginIO[];
  outputs?: PluginIO[];
  branches?: string[];
  schema?: JsonSchemaFragment;
  phase?: 'pre' | 'post' | 'both';
  stream?: boolean;
  protocol?: string;
  contentType?: string;
  seams?: SeamSubscription;
}

export interface PluginManifest {
  name: string;
  version: string;
  command?: string[];
  capabilities: PluginMethod[];
  components: ManifestComponent[];
  tools: ManifestTool[];
  /**
   * Files this plugin puts in the workspace of every node that runs.
   *
   * Top level rather than per component, for the same reason `tools` is: every
   * component of a plugin runs against the same workspace, so on a component
   * this would be a field nothing reads. `notOnComponents` refuses one written
   * there rather than ignoring it.
   *
   * Data, like the rest of this file — no verb behind it, nothing started to
   * find out. A plugin does not *write* into a workspace; it declares what it
   * ships and heddle copies, which is why this costs no capability.
   */
  files: ManifestFile[];
  /**
   * Whether this plugin's tool list has to be asked for rather than read.
   *
   * The exception to the rule the rest of this file exists to enforce, and it is
   * narrow on purpose. Everything else here is data, so heddle can learn what a
   * plugin provides without running it — which is what keeps `heddle validate`
   * free and lets a spec be inspected without executing its author's code.
   *
   * An MCP proxy cannot honour that. The tool list belongs to the server it
   * fronts, so a list committed to this file is a copy of somebody else's
   * registry as it stood the day a build step ran. Declaring this says: start me,
   * ask me once, and take the answer.
   *
   * **It costs the property above, so it is refused unless the operator opted
   * in.** heddle will not start a stranger's process because a manifest asked it
   * to. See `discoverTools` in `remote-loader.ts`.
   */
  discoverTools?: boolean;
}

export interface ManifestFile {
  /**
   * A path inside the plugin's own directory. A file or a directory.
   *
   * The same word for the same rule as {@link ManifestTool.path}: resolved
   * against the plugin's directory and refused if it lands outside. A second
   * word would make one rule look like two.
   */
  path: string;
  /** Where it lands in the workspace. `basename(path)` by default. */
  dest?: string;
}

export interface ManifestTool {
  name: string;
  description?: string;
  path?: string;
  componentType?: string;
  inputSchema?: JsonSchemaFragment;
  outputSchema?: JsonSchemaFragment;
  shadows?: boolean;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const KINDS: ManifestKind[] = [
  'node',
  'transform',
  'component',
  'provider',
  'middleware',
  'encoder',
  'store',
];

const PHASES = ['pre', 'post', 'both'];

const RENDERING_FIELDS = ['protocol', 'contentType'] as const;

const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 16;

/**
 * How many things one plugin may put in a workspace.
 *
 * A bound rather than a policy: each of these is copied into the workspace of
 * every node in every run, so a plugin that ships a hundred of them is a
 * hundred copies per node. The per-mount size budget is the operator's
 * (`--mount-max-bytes`); this one is heddle's, because a plugin's manifest is
 * not something the operator wrote.
 */
const MAX_MANIFEST_FILES = 64;

export function validateManifest(raw: unknown): PluginManifest {
  const manifest = asObject(raw, 'plugin manifest must be a JSON object');
  const name = readManifestName(manifest);

  readManifestVersion(manifest, name);
  // Before the check below, which consults it: a `discoverTools` of "yes" is a
  // bad boolean, and reporting it as "declares no components and no tools"
  // would send an author to the wrong field.
  assertBoolean(manifest, 'discoverTools', `plugin "${name}"`);
  assertDeclaresSomething(manifest, name);
  assertCommandShape(manifest, name);

  const componentTypes = new Set<string>();
  const components = rawComponentsOf(manifest, name).map((entry) =>
    readComponent(entry, name, componentTypes),
  );

  return {
    name,
    version: manifest.version as string,
    command: manifest.command as string[] | undefined,
    capabilities: asCapabilities(name, manifest.capabilities),
    components,
    tools: asTools(name, manifest.tools, componentTypes),
    files: asFiles(name, manifest.files),
    discoverTools: manifest.discoverTools === true,
  };
}

function assertBoolean(
  holder: Record<string, unknown>,
  field: string,
  where: string,
): void {
  if (holder[field] !== undefined && typeof holder[field] !== 'boolean') {
    fail(`${where} has a "${field}" that is not a boolean`);
  }
}

function readManifestName(manifest: Record<string, unknown>): string {
  if (typeof manifest.name !== 'string' || !manifest.name) {
    fail('plugin manifest is missing a "name"');
  }
  return manifest.name;
}

function readManifestVersion(
  manifest: Record<string, unknown>,
  name: string,
): void {
  if (typeof manifest.version !== 'string' || !manifest.version) {
    fail(`plugin "${name}" manifest is missing a "version"`);
  }
}

function assertDeclaresSomething(
  manifest: Record<string, unknown>,
  name: string,
): void {
  const declaresTools =
    Array.isArray(manifest.tools) && manifest.tools.length > 0;
  const declaresComponents =
    Array.isArray(manifest.components) && manifest.components.length > 0;
  // A discovery-only plugin is the shape an MCP proxy has: it declares nothing
  // statically because its tool list is the server's, not the manifest's. That
  // is a promise to answer `listTools`, so it counts as declaring something —
  // and a plugin that provides neither is still refused.
  const promisesTools = manifest.discoverTools === true;

  if (!declaresTools && !declaresComponents && !promisesTools) {
    // "files" deliberately does not count. A plugin that declares only files is
    // a data package, and heddle already has a way to put files in a workspace
    // that does not involve loading somebody's code -- so the error names it,
    // rather than letting "plugin" quietly become a file-shipping format.
    const onlyFiles = Array.isArray(manifest.files) && manifest.files.length > 0;

    fail(
      `plugin "${name}" manifest declares no components and no tools. A plugin ` +
        `whose tools are not known until it runs declares "discoverTools": true ` +
        `instead.` +
        (onlyFiles
          ? ` This one declares only "files", which is a directory rather than a ` +
            `plugin: mount it with --mount and load no code at all.`
          : ''),
    );
  }
}

function assertCommandShape(
  manifest: Record<string, unknown>,
  name: string,
): void {
  const { command } = manifest;
  if (command === undefined) return;

  const usable =
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((part) => typeof part === 'string');

  if (!usable) {
    fail(
      `plugin "${name}" has a "command" that is not a non-empty string array`,
    );
  }
}

function rawComponentsOf(
  manifest: Record<string, unknown>,
  name: string,
): unknown[] {
  if (manifest.components === undefined) return [];
  if (!Array.isArray(manifest.components)) {
    fail(`plugin "${name}" manifest has a "components" that is not an array`);
  }
  return manifest.components;
}

function readComponent(
  entry: unknown,
  plugin: string,
  seen: Set<string>,
): ManifestComponent {
  const component = asObject(
    entry,
    `plugin "${plugin}": each component must be an object`,
  );
  const componentType = readComponentType(component, plugin, seen);
  const kind = readKind(component, plugin, componentType);

  // Kind before value, for both. A `phase` on a provider and a `stream` on a
  // node are not bad values — they are fields nothing will ever read, which is
  // the failure this validator exists to prevent.
  onlyOn(component, 'phase', kind, 'transform', plugin, componentType);
  const phase = readPhase(component, plugin, componentType);

  onlyOn(component, 'stream', kind, 'provider', plugin, componentType);
  assertBoolean(
    component,
    'stream',
    `plugin "${plugin}": component "${componentType}"`,
  );

  notOnComponents(component, 'files', plugin, componentType);

  const rendering = asRendering(plugin, componentType, kind, component);

  return {
    componentType,
    kind,
    inputs: asIo(plugin, componentType, 'inputs', component.inputs),
    outputs: asIo(plugin, componentType, 'outputs', component.outputs),
    branches: asBranches(plugin, componentType, component.branches),
    schema: component.schema as JsonSchemaFragment | undefined,
    phase,
    // Only on the kind that owns it, so a validated manifest is valid input to
    // this function again. It was not: normalising `stream: false` onto every
    // component meant a second pass saw a node declaring `stream` and — once
    // `onlyOn` existed — refused it. `remotePluginFrom` validates, then
    // `loadRemotePlugin` validates what it was handed, so that second pass is
    // the ordinary CLI path rather than a hypothetical one.
    stream: kind === 'provider' ? component.stream === true : undefined,
    seams: asSeams(plugin, componentType, kind, component.seams),
    protocol: rendering?.protocol,
    contentType: rendering?.contentType,
  };
}

function readComponentType(
  component: Record<string, unknown>,
  plugin: string,
  seen: Set<string>,
): string {
  const componentType = component.componentType;

  if (typeof componentType !== 'string' || !NAME.test(componentType)) {
    fail(
      `plugin "${plugin}": componentType must match ${NAME.source}, got ${JSON.stringify(componentType)}`,
    );
  }
  if (seen.has(componentType)) {
    fail(`plugin "${plugin}" declares component type "${componentType}" twice`);
  }
  seen.add(componentType);

  return componentType;
}

function readKind(
  component: Record<string, unknown>,
  plugin: string,
  componentType: string,
): ManifestKind {
  const kind = component.kind ?? 'node';

  if (!KINDS.includes(kind as ManifestKind)) {
    fail(
      `plugin "${plugin}": component "${componentType}" has kind "${String(kind)}"; expected ${listOf(KINDS)}`,
    );
  }
  return kind as ManifestKind;
}

function readPhase(
  component: Record<string, unknown>,
  plugin: string,
  componentType: string,
): ManifestComponent['phase'] {
  const phase = component.phase;
  if (phase === undefined) return undefined;

  if (!PHASES.includes(phase as string)) {
    fail(
      `plugin "${plugin}": component "${componentType}" has phase "${String(phase)}"; expected ${listOf(PHASES)}`,
    );
  }
  return phase as ManifestComponent['phase'];
}

function asCapabilities(plugin: string, value: unknown): PluginMethod[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(`plugin "${plugin}": "capabilities" must be an array of strings`);
  }

  return value.map((entry) => {
    if (typeof entry !== 'string' || !isPluginMethod(entry)) {
      fail(
        `plugin "${plugin}" requests capability ${JSON.stringify(entry)}, ` +
          `which heddle does not serve. It serves: ${PLUGIN_METHODS.join(', ')}.`,
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
    const io = asObject(
      entry,
      `plugin "${plugin}": each entry in ${componentType}.${field} must be an object`,
    );

    if (typeof io.title !== 'string' || !io.title) {
      fail(
        `plugin "${plugin}": an entry in ${componentType}.${field} has no "title"`,
      );
    }
    if (typeof io.type !== 'string' || !io.type) {
      fail(
        `plugin "${plugin}": ${componentType}.${field}."${io.title}" has no "type"`,
      );
    }

    return {
      title: io.title,
      type: io.type,
      description:
        typeof io.description === 'string' ? io.description : undefined,
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
    fail(
      `plugin "${plugin}": ${componentType}.branches must be an array of strings`,
    );
  }
  return value as string[];
}

function asSeams(
  plugin: string,
  componentType: string,
  kind: ManifestKind,
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
 * Refuse a per-kind field on a component of the wrong kind.
 *
 * `seams` and the rendering pair were refused this way from the day each
 * landed; `phase` and `stream` were not, and checked only their *values* — so
 * `stream: true` on a node, or `phase: "post"` on a provider, loaded clean and
 * was read by nothing. That is this validator's own failure mode reached by the
 * one route nobody covered: not a value heddle rejects, but a field heddle
 * never looks at.
 *
 * Worth stating once, now that four fields obey it: a manifest field belongs to
 * exactly one kind, and writing it on another kind is a misunderstanding about
 * which kind you are — never a harmless extra.
 */
function onlyOn(
  component: Record<string, unknown>,
  field: string,
  kind: ManifestKind,
  required: ManifestKind,
  plugin: string,
  componentType: string,
): void {
  if (component[field] === undefined || kind === required) return;
  fail(
    `plugin "${plugin}": ${componentType} declares "${field}" but its kind is ` +
      `"${kind}". Only a ${required} uses it, so on a ${kind} it would be read by ` +
      `nothing — remove it, or correct the kind.`,
  );
}

/**
 * `onlyOn` arrived at from the other side.
 *
 * That one refuses a field belonging to a different *kind*; this refuses one
 * belonging to the *plugin*. Both are the same failure — a field heddle will
 * never read — and both are a misunderstanding rather than a harmless extra.
 */
function notOnComponents(
  component: Record<string, unknown>,
  field: string,
  plugin: string,
  componentType: string,
): void {
  if (component[field] === undefined) return;
  fail(
    `plugin "${plugin}": ${componentType} declares "${field}", which is the ` +
      `plugin's rather than a component's. Every component of a plugin runs ` +
      `against the same workspace, so here it would be read by nothing — move ` +
      `it to the top level of the manifest.`,
  );
}

function asFiles(plugin: string, raw: unknown): ManifestFile[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail(`plugin "${plugin}" manifest has a "files" that is not an array`);
  }
  if (raw.length > MAX_MANIFEST_FILES) {
    fail(
      `plugin "${plugin}" declares ${raw.length} files, over heddle's ` +
        `${MAX_MANIFEST_FILES}. Each one is copied into the workspace of every ` +
        `node in every run, so ship a directory rather than its contents.`,
    );
  }

  const claimed = new Set<string>();

  return raw.map((entry) => {
    const file = asObject(entry, `plugin "${plugin}": each file must be an object`);

    if (typeof file.path !== 'string' || file.path.length === 0) {
      fail(`plugin "${plugin}": a file has no "path"`);
    }
    if (
      file.dest !== undefined &&
      (typeof file.dest !== 'string' || file.dest.length === 0)
    ) {
      fail(
        `plugin "${plugin}": file "${file.path}" has a "dest" that is not a ` +
          `non-empty string`,
      );
    }

    const dest = (file.dest as string | undefined) ?? basename(file.path);
    if (claimed.has(dest)) {
      fail(
        `plugin "${plugin}" declares two files landing on "${dest}". One would ` +
          `be written over the other, and which depends on the order they were ` +
          `copied.`,
      );
    }
    claimed.add(dest);

    return { path: file.path, dest };
  });
}

function asRendering(
  plugin: string,
  componentType: string,
  kind: ManifestKind,
  component: Record<string, unknown>,
): { protocol: string; contentType: string } | undefined {
  const where = `plugin "${plugin}": ${componentType}`;

  if (kind !== 'encoder') {
    for (const field of RENDERING_FIELDS) {
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

/**
 * Check a tool list a plugin answered `listTools` with.
 *
 * Exactly the machinery a manifest's `tools` goes through, and that is the whole
 * design: a discovered tool is a manifest tool that arrived late. The same name
 * rule, the same `path` xor `componentType` exclusivity, the same schema byte
 * and depth caps. Anything weaker would make discovery a way *around* this
 * validator rather than an input to it — and this list came out of a process,
 * which is a less trustworthy source than a file an operator installed.
 */
export function readDiscoveredTools(
  plugin: string,
  raw: unknown,
  componentTypes: Set<string>,
): ManifestTool[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(`plugin "${plugin}" answered listTools with something that is not an object`);
  }
  const { tools } = raw as { tools?: unknown };
  if (tools === undefined) {
    fail(
      `plugin "${plugin}" answered listTools with no "tools". A plugin with none ` +
        `to offer answers { "tools": [] }, which is not the same as not answering.`,
    );
  }
  return asTools(plugin, tools, componentTypes);
}

function asTools(
  plugin: string,
  value: unknown,
  componentTypes: Set<string>,
): ManifestTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail(`plugin "${plugin}": "tools" must be an array`);
  }

  const seen = new Set<string>();
  return value.map((entry) => readTool(entry, plugin, componentTypes, seen));
}

function readTool(
  entry: unknown,
  plugin: string,
  componentTypes: Set<string>,
  seen: Set<string>,
): ManifestTool {
  const tool = asObject(
    entry,
    `plugin "${plugin}": each entry in "tools" must be an object`,
  );
  const name = readToolName(tool, plugin, seen);

  const hasPath = tool.path !== undefined;
  const hasComponent = tool.componentType !== undefined;
  assertExactlyOneImplementation(plugin, name, hasPath, hasComponent);

  if (hasPath && (typeof tool.path !== 'string' || tool.path.length === 0)) {
    fail(`plugin "${plugin}": tool "${name}" has a "path" that is not a string`);
  }
  if (hasComponent) {
    assertKnownComponent(plugin, name, tool.componentType, componentTypes);
  }
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    fail(
      `plugin "${plugin}": tool "${name}" has a "description" that is not a string`,
    );
  }
  if (tool.shadows !== undefined && typeof tool.shadows !== 'boolean') {
    fail(
      `plugin "${plugin}": tool "${name}" has a "shadows" that is not a boolean`,
    );
  }

  checkToolSchema(plugin, name, 'inputSchema', tool.inputSchema);
  checkToolSchema(plugin, name, 'outputSchema', tool.outputSchema);

  return {
    name,
    description:
      typeof tool.description === 'string' ? tool.description : undefined,
    path: hasPath ? (tool.path as string) : undefined,
    componentType: hasComponent ? (tool.componentType as string) : undefined,
    inputSchema: tool.inputSchema as JsonSchemaFragment | undefined,
    outputSchema: tool.outputSchema as JsonSchemaFragment | undefined,
    shadows: tool.shadows === true,
  };
}

function readToolName(
  tool: Record<string, unknown>,
  plugin: string,
  seen: Set<string>,
): string {
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

  return tool.name;
}

function assertExactlyOneImplementation(
  plugin: string,
  name: string,
  hasPath: boolean,
  hasComponent: boolean,
): void {
  if (hasPath !== hasComponent) return;

  fail(
    `plugin "${plugin}": tool "${name}" must have exactly one of "path" — an ` +
      `executable shipped beside the plugin — or "componentType", naming the ` +
      `component in this plugin that implements it. ` +
      `${hasPath ? 'It has both.' : 'It has neither.'}`,
  );
}

function assertKnownComponent(
  plugin: string,
  name: string,
  componentType: unknown,
  componentTypes: Set<string>,
): void {
  if (
    typeof componentType === 'string' &&
    componentTypes.has(componentType)
  ) {
    return;
  }

  const declared =
    componentTypes.size > 0 ? [...componentTypes].join(', ') : 'nothing';
  fail(
    `plugin "${plugin}": tool "${name}" names componentType ` +
      `${JSON.stringify(componentType)}, which this plugin does not declare. ` +
      `It declares: ${declared}.`,
  );
}

function checkToolSchema(
  plugin: string,
  tool: string,
  field: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(
      `plugin "${plugin}": tool "${tool}" has a "${field}" that is not a JSON Schema object`,
    );
  }

  const json = JSON.stringify(value);
  if (json.length > MAX_SCHEMA_BYTES) {
    fail(
      `plugin "${plugin}": tool "${tool}" has a "${field}" of ${json.length} bytes, over ` +
        `heddle's ${MAX_SCHEMA_BYTES}. It is sent to the model on every round of every ` +
        `turn, so its size is a cost the flow pays repeatedly.`,
    );
  }

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

function listOf(options: readonly string[]): string {
  const all = [...options];
  const last = all.pop();
  return all.length > 0 ? `${all.join(', ')} or ${last}` : String(last);
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(message);
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new PluginError(message);
}
