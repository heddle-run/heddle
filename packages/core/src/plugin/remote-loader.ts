import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { SandboxSession } from '../sandbox/types.js';
import type { Workspace } from '../workspace/index.js';
import { PluginError } from '../errors.js';
import { PluginHost, type PluginHostOptions } from './host.js';
import {
  readDiscoveredTools,
  validateManifest,
  type ManifestTool,
  type PluginManifest,
} from './manifest.js';
import type { ToolDef } from '../tool/types.js';
import type { PluginCapability } from './protocol.js';
import {
  remoteComponentDef,
  remoteEncoderDef,
  remoteMiddlewareDef,
  remoteNodeDef,
  remoteProviderDef,
  remoteToolDef,
  remoteTransformDef,
} from './remote.js';
import { PLUGIN_RUNTIME_JS } from './runtime-source.js';
import { SEAMS, type AfterAction, type Seam } from './seams.js';
import type { HeddlePlugin } from './types.js';

const EXECUTABLE_BITS = 0o111;
const SCRIPT_EXTENSIONS = ['.mjs', '.js'];

/**
 * The runtime, as something `node --import` will take.
 *
 * A submitted plugin gets the runtime prepended to its source, because it is
 * written to a directory with nothing else in it. A plugin on disk cannot be
 * rewritten — it is the operator's file — so the same runtime arrives on the
 * command line instead, and `serve` is a global either way.
 *
 * A `data:` URL rather than a path to a file this package ships, because a path
 * is a thing the sandbox would have to grant. This needs no filesystem at all,
 * so a confined plugin gets its runtime on exactly the terms an unconfined one
 * does. It costs ~22 KB of argv, which is a fortieth of `ARG_MAX` and contains
 * nothing that is not already open source.
 */
const RUNTIME_IMPORT = `data:text/javascript,${encodeURIComponent(
  `${PLUGIN_RUNTIME_JS}\nglobalThis.serve = serve;\n`,
)}`;

export interface RemotePluginOptions {
  timeout?: number;
  session?: SandboxSession;
  /** Somewhere the plugin's process may write. See `PluginHostOptions`. */
  workspace?: Workspace;
  env?: Record<string, string>;
  capabilities?: PluginCapability[];
  refusedBecause?: Partial<Record<PluginCapability, string>>;
  root?: string;
  /** Whether this process will serve more than one run. See `PluginHostOptions`. */
  shared?: boolean;
  /** Where the plugin's own stderr goes. See `PluginHostOptions`. */
  onStderr?: (chunk: string) => void;
}

export interface RemotePlugin {
  plugin: HeddlePlugin;
  host: PluginHost;
}

export function loadRemotePlugin(
  rawManifest: unknown,
  entryPath: string,
  options: RemotePluginOptions = {},
): RemotePlugin {
  const manifest = validateManifest(rawManifest);
  checkGrant(
    manifest,
    options.capabilities ?? [],
    options.refusedBecause ?? {},
  );

  const entry = isAbsolute(entryPath)
    ? entryPath
    : resolve(process.cwd(), entryPath);
  const root = options.root ?? dirname(entry);

  const host = new PluginHost(
    manifest.name,
    hostOptionsFor(manifest, entry, root, options),
  );
  const getHost = (): PluginHost => host;

  return { plugin: buildPlugin(manifest, root, getHost), host };
}

export function readManifest(path: string): PluginManifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new PluginError(`plugin manifest "${path}" is not readable`, {
      cause: err,
    });
  }

  try {
    return validateManifest(JSON.parse(raw));
  } catch (err) {
    if (err instanceof PluginError) throw err;
    throw new PluginError(`plugin manifest "${path}" is not valid JSON`, {
      cause: err,
    });
  }
}

function hostOptionsFor(
  manifest: PluginManifest,
  entry: string,
  root: string,
  options: RemotePluginOptions,
): PluginHostOptions {
  return {
    command: commandFor(manifest, entry, root),
    cwd: root,
    timeout: options.timeout,
    session: options.session,
    workspace: options.workspace,
    env: options.env,
    capabilities: manifest.capabilities,
    seams: admittedVerdicts(manifest),
    shared: options.shared,
    onStderr: options.onStderr,
  };
}

function commandFor(
  manifest: PluginManifest,
  entry: string,
  root: string,
): string[] {
  if (!manifest.command) return defaultCommand(entry);

  return manifest.command.map((part, index) =>
    index === 0 && !isAbsolute(part) && part.includes('/')
      ? resolve(root, part)
      : part,
  );
}

function defaultCommand(entry: string): string[] {
  let mode: number;
  try {
    mode = statSync(entry).mode;
  } catch (err) {
    throw new PluginError(`plugin entry point "${entry}" is not accessible`, {
      cause: err,
    });
  }

  // An executable brings its own interpreter and may not be JavaScript at all,
  // so it is run as it is. The runtime is for the case heddle chose the
  // interpreter, which is the only case it knows what to inject into.
  if ((mode & EXECUTABLE_BITS) !== 0) return [entry];

  if (SCRIPT_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
    return [process.execPath, '--import', RUNTIME_IMPORT, entry];
  }

  throw new PluginError(
    `plugin entry point "${entry}" is not executable and is not a .mjs/.js file. ` +
      `Either make it executable with a shebang, or set "command" in the manifest.`,
  );
}

function buildPlugin(
  manifest: PluginManifest,
  root: string,
  getHost: () => PluginHost,
): HeddlePlugin {
  const plugin: HeddlePlugin = {
    name: manifest.name,
    version: manifest.version,
    nodes: [],
    transforms: [],
    components: [],
    providers: [],
    middleware: [],
    encoders: [],
    tools: manifest.tools.map((tool) =>
      toolDefFor(manifest, tool, root, getHost),
    ),
  };

  for (const component of manifest.components) {
    switch (component.kind ?? 'node') {
      case 'node':
        plugin.nodes?.push(remoteNodeDef(manifest, component, getHost));
        break;
      case 'transform':
        plugin.transforms?.push(
          remoteTransformDef(manifest, component, getHost),
        );
        break;
      case 'component':
        plugin.components?.push(remoteComponentDef(component));
        break;
      case 'provider':
        plugin.providers?.push(remoteProviderDef(manifest, component, getHost));
        break;
      case 'middleware':
        plugin.middleware?.push(
          remoteMiddlewareDef(manifest, component, getHost),
        );
        break;
      case 'encoder':
        plugin.encoders?.push(remoteEncoderDef(manifest, component, getHost));
        break;
    }
  }

  return plugin;
}

/**
 * Ask a plugin what tools it has, and add them to what it already declared.
 *
 * **The one place heddle starts a plugin to learn what it provides**, and the
 * exception is bought rather than granted: a manifest asking for it is not
 * enough, the operator has to opt in as well, so `loadRemotePlugin` stays a
 * function that reads data and this stays a function somebody called.
 *
 * That split is what protects `heddle validate`. Loading is still free and still
 * executes nothing; discovery is a separate, awaited step that a caller either
 * takes or does not. The server takes it nowhere, which is why validating a
 * submitted flow starts no process however its plugins are written.
 *
 * **Once, at load, and cached for the registry's lifetime** — which is the whole
 * of why `Registry.lookup` can stay synchronous. Discovery happens before the
 * registry is built rather than inside it, so the three call sites that resolve
 * a tool name during execution and request validation never wait on a pipe.
 *
 * A plugin that declares tools *and* discovers them gets both, its own first. A
 * discovered tool colliding with one of its declared tools is a duplicate name
 * and refused as one.
 */
export async function discoverTools(
  remote: RemotePlugin,
  manifest: PluginManifest,
  root: string,
): Promise<void> {
  if (!manifest.discoverTools) return;

  const answer = await remote.host.call('listTools', {});
  const componentTypes = new Set(manifest.components.map((c) => c.componentType));
  const declared = manifest.tools;
  const discovered = readDiscoveredTools(
    manifest.name,
    answer,
    componentTypes,
  );

  // Re-validated as one list, so a discovered name colliding with a declared one
  // is caught here by the same duplicate check rather than becoming a registry
  // collision whose error names the wrong thing.
  const all = readDiscoveredTools(
    manifest.name,
    { tools: [...declared, ...discovered] },
    componentTypes,
  );

  const getHost = (): PluginHost => remote.host;
  remote.plugin.tools = all.map((tool) =>
    toolDefFor(manifest, tool, root, getHost),
  );
}

function admittedVerdicts(
  manifest: PluginManifest,
): Record<string, AfterAction[]> | undefined {
  const admitted: Record<string, AfterAction[]> = {};

  for (const component of manifest.components) {
    for (const seam of Object.keys(component.seams ?? {}) as Seam[]) {
      admitted[seam] = SEAMS[seam].after;
    }
  }

  return Object.keys(admitted).length > 0 ? admitted : undefined;
}

function toolDefFor(
  manifest: PluginManifest,
  tool: ManifestTool,
  root: string,
  getHost: () => PluginHost,
): ToolDef {
  if (tool.componentType !== undefined) {
    return remoteToolDef(manifest, tool, getHost);
  }

  return {
    name: tool.name,
    description: tool.description ?? '',
    origin: `plugin:${manifest.name}`,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    shadows: tool.shadows,
    impl: { kind: 'path', path: resolveShippedExecutable(manifest, tool, root) },
  };
}

function resolveShippedExecutable(
  manifest: PluginManifest,
  tool: ManifestTool,
  root: string,
): string {
  const real = resolveInsidePlugin(manifest, tool, root);
  const info = statSync(real);

  if (!info.isFile()) {
    throw new PluginError(
      `plugin "${manifest.name}": tool "${tool.name}" names "${tool.path}", which is ` +
        `a directory. A tool is a program heddle runs, and a directory carries the ` +
        `execute bit for being traversable rather than for being runnable.`,
    );
  }
  if ((info.mode & EXECUTABLE_BITS) === 0) {
    throw new PluginError(
      `plugin "${manifest.name}": tool "${tool.name}" names "${tool.path}", which is ` +
        `not executable. heddle runs a tool as a program, so it needs the execute bit ` +
        `and a shebang.`,
    );
  }

  return real;
}

function resolveInsidePlugin(
  manifest: PluginManifest,
  tool: ManifestTool,
  root: string,
): string {
  const target = resolve(root, tool.path as string);

  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(target);
    realRoot = realpathSync(root);
  } catch (err) {
    throw new PluginError(
      `plugin "${manifest.name}": tool "${tool.name}" names "${tool.path}", which is ` +
        `not there beside the plugin.`,
      { cause: err },
    );
  }

  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new PluginError(
      `plugin "${manifest.name}": tool "${tool.name}" resolves to "${real}", outside ` +
        `the plugin's own directory. A plugin ships the executables it declares; to ` +
        `reach a program elsewhere, ship a wrapper that calls it.`,
    );
  }

  return real;
}

function checkGrant(
  manifest: PluginManifest,
  granted: PluginCapability[],
  reasons: Partial<Record<PluginCapability, string>>,
): void {
  const allowed = new Set(granted);
  const refused = manifest.capabilities.filter(
    (capability) => !allowed.has(capability),
  );
  if (refused.length === 0) return;

  throw new PluginError(refusedGrantMessage(manifest, granted, refused, reasons));
}

function refusedGrantMessage(
  manifest: PluginManifest,
  granted: PluginCapability[],
  refused: PluginCapability[],
  reasons: Partial<Record<PluginCapability, string>>,
): string {
  const why = refused
    .map((capability) => reasons[capability])
    .filter((reason): reason is string => reason !== undefined);
  const explanation = why.length > 0 ? `\n\n${why.join('\n\n')}` : '';

  return (
    `plugin "${manifest.name}" requests ${refused.map((c) => `"${c}"`).join(', ')}, ` +
    `which this host does not grant. Granted here: ` +
    `${granted.length > 0 ? granted.join(', ') : 'nothing'}. ` +
    `A capability is the operator's to give, so the plugin cannot obtain it by ` +
    `asking differently — drop it from the manifest, or run the plugin somewhere ` +
    `it is granted.${explanation}`
  );
}
