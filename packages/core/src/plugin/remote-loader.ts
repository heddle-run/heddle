/**
 * Loads a plugin that runs in its own process.
 *
 * The contrast with `loader.ts` is the whole point of this design. That one
 * `import()`s a module, which executes it: by the time heddle knows what the
 * plugin provides, the plugin has already run inside the server. Here nothing
 * is executed to find that out — the manifest is read as data, and the
 * plugin's process is not started until a node using it actually runs.
 *
 * What comes back is an ordinary {@link HeddlePlugin}, so `PluginRegistry`,
 * the deserializer and `compile()` treat it exactly like an in-process one.
 */
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
  remoteMiddlewareDef,
  remoteNodeDef,
  remoteToolDef,
  remoteTransformDef,
} from './remote.js';
import { SEAMS, type AfterAction, type Seam } from './seams.js';
import type { HeddlePlugin } from './types.js';

/** The verdicts every seam this manifest subscribes to will admit. */
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

export interface RemotePluginOptions {
  /** Wall-clock budget for a single call into the plugin. */
  timeout?: number;
  /** Confines the plugin process, as a sandbox would confine a tool. */
  session?: SandboxSession;
  /**
   * Environment for the plugin process. Empty by default — a plugin sees no
   * variable it was not explicitly given, which is the property the in-process
   * API could not offer at any price.
   */
  env?: Record<string, string>;
  /**
   * Capabilities this plugin may use. A manifest that asks for one not listed
   * here fails to load, naming the capability — the operator's policy is not
   * something a submitted plugin gets to discover by probing at runtime.
   *
   * Empty by default, for the same reason the environment is: a caller that
   * granted nothing on the heddle they installed should not find a plugin
   * newly able to spend their model credential because a later version learned
   * how. Widening is a decision someone makes, and it looks like one here.
   */
  capabilities?: PluginCapability[];
  /**
   * Why a capability was withheld, in the words of whoever withheld it.
   *
   * A grant list says what is allowed; only its author knows why. "This host
   * does not grant callModel" sends a plugin author to re-read their manifest,
   * which is correct and useless when the real answer is that the server
   * supplies a model credential and will not let submitted code spend it. Core
   * has no business knowing that sentence, so the operator supplies it here and
   * {@link checkGrant} appends it to the refusal.
   */
  refusedBecause?: Partial<Record<PluginCapability, string>>;
  /**
   * The plugin's own directory, when it is not the entry point's.
   *
   * Everything a manifest names relatively is resolved against this: the
   * program in `command`, the process's cwd, and the executables its tools
   * declare. `dirname(entry)` is the right answer whenever the entry point sits
   * beside the manifest, which is why it is the default — and the wrong one the
   * moment a manifest says `"command": ["/usr/bin/python3", "server.py"]`,
   * where the entry is an interpreter somewhere else entirely. Taken from there,
   * the containment check that keeps a plugin's tools inside its own directory
   * would be enforcing `/usr/bin`, which inverts it: the plugin's real tools are
   * refused and any system binary passes.
   */
  root?: string;
}

/** A loaded out-of-process plugin, and the process behind it. */
export interface RemotePlugin {
  plugin: HeddlePlugin;
  host: PluginHost;
}

/**
 * How to start a plugin whose manifest does not say.
 *
 * An executable entry is invoked by path, and that is the preferred form for a
 * reason that only shows up under `--safe`: a sandbox binds the *program* it is
 * given into the confined filesystem, and nothing else. Launch a plugin as
 * `node /path/plugin.mjs` and the script is an argument rather than the
 * program, so it is never bound and the confined node cannot find it —
 * `Cannot find module`. Invoked by path, the plugin is bound exactly as a tool
 * is, and needs no policy change.
 *
 * A non-executable `.mjs`/`.js` still works, for plugins on disk that nobody
 * chmod'd. Under a sandbox those need their directory in the policy's
 * `readPaths`.
 */
function defaultCommand(entry: string): string[] {
  let mode: number;
  try {
    mode = statSync(entry).mode;
  } catch (err) {
    throw new PluginError(`plugin entry point "${entry}" is not accessible`, { cause: err });
  }

  if ((mode & 0o111) !== 0) return [entry];

  if (entry.endsWith('.mjs') || entry.endsWith('.js')) {
    return [process.execPath, entry];
  }

  throw new PluginError(
    `plugin entry point "${entry}" is not executable and is not a .mjs/.js file. ` +
      `Either make it executable with a shebang, or set "command" in the manifest.`,
  );
}

/**
 * Build a plugin from a manifest and an entry point.
 *
 * `manifest` is taken as unparsed data rather than a path so the same function
 * serves a plugin on disk and one that arrived in a request body.
 */
export function loadRemotePlugin(
  rawManifest: unknown,
  entryPath: string,
  options: RemotePluginOptions = {},
): RemotePlugin {
  const manifest = validateManifest(rawManifest);
  checkGrant(manifest, options.capabilities ?? [], options.refusedBecause ?? {});
  const entry = isAbsolute(entryPath) ? entryPath : resolve(process.cwd(), entryPath);
  const root = options.root ?? dirname(entry);

  const command = manifest.command
    ? // Resolved against the plugin's own directory, so a manifest can name a
      // helper shipped beside it without knowing where it was installed.
      manifest.command.map((part, i) =>
        i === 0 && !isAbsolute(part) && part.includes('/')
          ? resolve(root, part)
          : part,
      )
    : defaultCommand(entry);

  const hostOptions: PluginHostOptions = {
    command,
    cwd: root,
    timeout: options.timeout,
    session: options.session,
    env: options.env,
    // The manifest's request, not the grant. Both have to allow a call, and
    // this is where they meet: `checkGrant` above rejected anything asked for
    // and not granted, so what a plugin declared is exactly what it may use.
    // Passing the grant instead would give a plugin capabilities it never asked
    // for, which is the implicit availability this replaces.
    capabilities: manifest.capabilities,
    // The verdicts each seam this plugin subscribed to will admit, sent with
    // the handshake for the same reason the capabilities are: a middleware
    // should read its limits rather than discover one by being refused, which
    // under the fatal policy costs the run.
    seams: admittedVerdicts(manifest),
  };

  const host = new PluginHost(manifest.name, hostOptions);
  // A thunk rather than the host itself: the defs are built now, but nothing
  // should touch the process until a node actually executes.
  const getHost = (): PluginHost => host;

  const plugin: HeddlePlugin = {
    name: manifest.name,
    version: manifest.version,
    nodes: [],
    transforms: [],
    components: [],
    middleware: [],
  };

  for (const entryComponent of manifest.components) {
    switch (entryComponent.kind ?? 'node') {
      case 'node':
        plugin.nodes!.push(remoteNodeDef(manifest, entryComponent, getHost));
        break;
      case 'transform':
        plugin.transforms!.push(remoteTransformDef(manifest, entryComponent, getHost));
        break;
      case 'component':
        plugin.components!.push(remoteComponentDef(entryComponent));
        break;
      case 'middleware':
        plugin.middleware!.push(remoteMiddlewareDef(manifest, entryComponent, getHost));
        break;
    }
  }

  plugin.tools = manifest.tools.map((tool) => toolDefFor(manifest, tool, root, getHost));

  return { plugin, host };
}

/**
 * One manifest tool, as the registry will hold it.
 *
 * The path form is resolved and checked here, at load, and that is what keeps
 * `assertToolsAvailable` meaning what it has always meant. Before this a tool
 * existing meant an executable existed; a manifest that merely *says* a tool
 * exists would quietly weaken that to "somebody claimed so", and the failure
 * would move from a 400 before the run to a spawn error partway through it.
 *
 * Containment is checked with `realpath` rather than string arithmetic, because
 * the thing being defended against is a symlink: `../../../usr/bin/curl` is
 * caught by either, and a link inside the plugin directory pointing out of it is
 * caught only by resolving it. A plugin naming a program outside its own
 * directory is not obviously an attack — but it is indistinguishable from one,
 * and a plugin that needs a system binary can ship a two-line wrapper.
 */
function toolDefFor(
  manifest: PluginManifest,
  tool: ManifestTool,
  root: string,
  getHost: () => PluginHost,
): ToolDef {
  if (tool.componentType !== undefined) {
    return remoteToolDef(manifest, tool, getHost);
  }

  const target = resolve(root, tool.path!);

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

  const info = statSync(real);
  if (!info.isFile()) {
    throw new PluginError(
      `plugin "${manifest.name}": tool "${tool.name}" names "${tool.path}", which is ` +
        `a directory. A tool is a program heddle runs, and a directory carries the ` +
        `execute bit for being traversable rather than for being runnable.`,
    );
  }
  if ((info.mode & 0o111) === 0) {
    throw new PluginError(
      `plugin "${manifest.name}": tool "${tool.name}" names "${tool.path}", which is ` +
        `not executable. heddle runs a tool as a program, so it needs the execute bit ` +
        `and a shebang.`,
    );
  }

  return {
    name: tool.name,
    description: tool.description ?? '',
    origin: `plugin:${manifest.name}`,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    shadows: tool.shadows,
    impl: { kind: 'path', path: real },
  };
}

/**
 * Refuse a plugin that asks for more than it was granted.
 *
 * At load, before the process exists, and naming the capability. The
 * alternative — letting it load and failing the call — hides an operator's
 * policy behind whichever branch of a plugin happens to run, so a flow that
 * never reaches the guardrail's tool call would look fine until the day one
 * does. It also leaves nowhere to report the mismatch except the middle of
 * someone's run.
 */
function checkGrant(
  manifest: PluginManifest,
  granted: PluginCapability[],
  reasons: Partial<Record<PluginCapability, string>>,
): void {
  const allowed = new Set(granted);
  const refused = manifest.capabilities.filter((capability) => !allowed.has(capability));
  if (refused.length === 0) return;

  // Only for the capabilities actually refused, and only where the host said
  // something. A plugin asking for three and being told why one of them is out
  // is more use than a paragraph of policy about verbs it never mentioned.
  const why = refused
    .map((capability) => reasons[capability])
    .filter((reason): reason is string => reason !== undefined);

  throw new PluginError(
    `plugin "${manifest.name}" requests ${refused.map((c) => `"${c}"`).join(', ')}, ` +
      `which this host does not grant. Granted here: ` +
      `${granted.length > 0 ? granted.join(', ') : 'nothing'}. ` +
      `A capability is the operator's to give, so the plugin cannot obtain it by ` +
      `asking differently — drop it from the manifest, or run the plugin somewhere ` +
      `it is granted.${why.length > 0 ? `\n\n${why.join('\n\n')}` : ''}`,
  );
}

/** Read a manifest from disk. Data only — nothing is executed. */
export function readManifest(path: string): PluginManifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new PluginError(`plugin manifest "${path}" is not readable`, { cause: err });
  }
  try {
    return validateManifest(JSON.parse(raw));
  } catch (err) {
    if (err instanceof PluginError) throw err;
    throw new PluginError(`plugin manifest "${path}" is not valid JSON`, { cause: err });
  }
}
