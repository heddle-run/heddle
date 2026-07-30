import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { SandboxSession } from '../sandbox/types.js';
import { PluginError } from '../errors.js';
import { PluginHost, type PluginHostOptions } from './host.js';
import {
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
import { SEAMS, type AfterAction, type Seam } from './seams.js';
import type { HeddlePlugin } from './types.js';

const EXECUTABLE_BITS = 0o111;
const SCRIPT_EXTENSIONS = ['.mjs', '.js'];

export interface RemotePluginOptions {
  timeout?: number;
  session?: SandboxSession;
  env?: Record<string, string>;
  capabilities?: PluginCapability[];
  refusedBecause?: Partial<Record<PluginCapability, string>>;
  root?: string;
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
    env: options.env,
    capabilities: manifest.capabilities,
    seams: admittedVerdicts(manifest),
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

  if ((mode & EXECUTABLE_BITS) !== 0) return [entry];

  if (SCRIPT_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
    return [process.execPath, entry];
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
