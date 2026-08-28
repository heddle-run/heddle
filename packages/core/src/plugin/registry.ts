import type {
  HeddlePlugin,
  PluginComponentDef,
  PluginEncoderDef,
  PluginMiddlewareDef,
  PluginNodeDef,
  PluginProviderDef,
  PluginStoreDef,
  PluginTransformDef,
} from './types.js';
import type { SessionStore } from '../session/store.js';
import { BUILTIN_PROTOCOL, PROTOCOL_NAME } from './encoder.js';
import type { PluginHost } from './host.js';
import type { Registry, ToolDef } from '../tool/types.js';
import { assertNoCollisions, type Mount } from '../workspace/index.js';
import {
  BUILTIN_INPUT_FORMATS,
  INPUT_FORMAT_NAME,
  type InputFormatDef,
} from '../spec/input-format.js';
import { PluginError } from '../errors.js';

export type ComponentKind =
  | 'node'
  | 'transform'
  | 'component'
  | 'provider'
  | 'middleware'
  | 'encoder'
  | 'store';

const SPEC_WRITABLE_KINDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'node',
  'transform',
  'component',
  'provider',
]);

/**
 * The kinds a submitted plugin may carry, for a host that accepts one.
 *
 * The spec-writable kinds plus `encoder`, which a request selects for itself —
 * a rendering belongs to the client asking for it. Everything else is the
 * operator's: middleware runs on every node of every flow, and a store holds
 * every conversation the server has. An allowlist rather than the refusals'
 * complement, so a kind this file grows later is refused in a request until
 * somebody decides it should not be.
 */
export const SUBMITTABLE_KINDS: ReadonlySet<ComponentKind> =
  new Set<ComponentKind>([
    'node',
    'transform',
    'component',
    'provider',
    'encoder',
  ]);

interface Registered {
  kind: ComponentKind;
  def: PluginComponentDef;
  /** The providing plugin's version — what a document's `requires` checks. */
  version: string;
}

export interface RegisteredMiddleware {
  plugin: string;
  def: PluginMiddlewareDef;
}

interface RegisteredEncoder {
  plugin: string;
  def: PluginEncoderDef;
}

interface RegisteredStore {
  plugin: string;
  def: PluginStoreDef;
}

interface RegisteredInputFormat {
  plugin: string;
  def: InputFormatDef;
}

export class PluginRegistry {
  private readonly defs = new Map<string, Registered>();
  private readonly pluginNames: string[] = [];
  private readonly middlewares: RegisteredMiddleware[] = [];
  private readonly encoders = new Map<string, RegisteredEncoder>();
  private readonly stores = new Map<string, RegisteredStore>();
  private readonly formats = new Map<string, RegisteredInputFormat>();
  private readonly formatExtensions = new Map<string, string>();
  private readonly toolDefs: ToolDef[] = [];
  private readonly toolOwners = new Map<string, string>();
  private readonly mounts: Mount[] = [];
  private hosts: PluginHost[] = [];

  static empty(): PluginRegistry {
    return new PluginRegistry();
  }

  static fromPlugins(plugins: HeddlePlugin[]): PluginRegistry {
    const registry = new PluginRegistry();
    for (const plugin of plugins) registry.add(plugin);
    return registry;
  }

  add(plugin: HeddlePlugin): void {
    assertIdentified(plugin);

    this.registerSpecComponents(plugin);
    this.registerMiddleware(plugin);
    this.registerEncoders(plugin);
    this.registerInputFormats(plugin);
    this.registerStores(plugin);
    this.registerTools(plugin);
    this.registerFiles(plugin);

    this.pluginNames.push(`${plugin.name}@${plugin.version}`);
  }

  addRemote(remote: { plugin: HeddlePlugin; host: PluginHost }): void {
    this.add(remote.plugin);
    this.hosts.push(remote.host);
  }

  /**
   * A registry holding everything this one holds, plus whatever is added to it
   * — and owning none of this one's processes.
   *
   * What lets an installed plugin outlive the run that used it. An operator's
   * plugins are loaded once and their processes serve every run on the server;
   * a run layers whatever the request submitted onto a copy of that registry,
   * and disposes the copy when it ends. `hosts` is the one thing deliberately
   * left behind: `dispose` is how a run stops the plugins it started, and a run
   * must not stop the ones it found already running.
   *
   * Names carry over, so a submitted plugin declaring a component type an
   * installed one already provides is refused by {@link claim} rather than
   * shadowing it. That is the property worth having on a server: request code
   * cannot take a name the operator's own flows resolve.
   */
  extend(): PluginRegistry {
    const copy = new PluginRegistry();

    for (const [componentType, entry] of this.defs) {
      copy.defs.set(componentType, entry);
    }
    for (const [name, owner] of this.toolOwners) copy.toolOwners.set(name, owner);
    for (const [protocol, entry] of this.encoders) {
      copy.encoders.set(protocol, entry);
    }
    for (const [name, entry] of this.formats) copy.formats.set(name, entry);
    for (const [extension, name] of this.formatExtensions) {
      copy.formatExtensions.set(extension, name);
    }
    copy.pluginNames.push(...this.pluginNames);
    copy.middlewares.push(...this.middlewares);
    copy.toolDefs.push(...this.toolDefs);
    // Carried over for the reason names are: a submitted plugin must not be
    // able to take a workspace path an installed one already claimed. Moot on
    // a server, which refuses `files` in a request outright, but the invariant
    // should hold by construction rather than by a second rule agreeing.
    copy.mounts.push(...this.mounts);

    return copy;
  }

  dispose(): void {
    for (const host of this.hosts) host.dispose();
    this.hosts = [];
  }

  kindOf(componentType: string): ComponentKind | undefined {
    return this.defs.get(componentType)?.kind;
  }

  /**
   * The version of the plugin providing a component type — what a document's
   * `requires` pin is checked against.
   */
  versionOf(componentType: string): string | undefined {
    return this.defs.get(componentType)?.version;
  }

  nodeDef(componentType: string): PluginNodeDef | undefined {
    return this.defOfKind<PluginNodeDef>(componentType, 'node');
  }

  transformDef(componentType: string): PluginTransformDef | undefined {
    return this.defOfKind<PluginTransformDef>(componentType, 'transform');
  }

  providerDef(componentType: string): PluginProviderDef | undefined {
    return this.defOfKind<PluginProviderDef>(componentType, 'provider');
  }

  middlewareDefs(): RegisteredMiddleware[] {
    return this.middlewares;
  }

  encoderDef(protocol: string): PluginEncoderDef | undefined {
    return this.encoders.get(protocol)?.def;
  }

  encoderProtocols(): string[] {
    return [...this.encoders.keys()].sort();
  }

  inputFormatDef(name: string): InputFormatDef | undefined {
    return this.formats.get(name)?.def;
  }

  inputFormatForExtension(extension: string): InputFormatDef | undefined {
    const name = this.formatExtensions.get(extension.toLowerCase());
    return name === undefined ? undefined : this.formats.get(name)?.def;
  }

  inputFormatNames(): string[] {
    return [...this.formats.keys()].sort();
  }

  /**
   * Build the store this component type provides, or nothing if none does.
   *
   * Called once, at startup, by whoever was told which store to use. It is a
   * `create` rather than a lookup because a store holds a connection or a
   * handle and the registry should not be the thing that opens one — a
   * registry that built every store it knew about would connect to databases
   * nobody selected.
   */
  createStore(
    componentType: string,
    config: Record<string, unknown> = {},
  ): SessionStore | undefined {
    return this.stores.get(componentType)?.def.createStore(config);
  }

  toolRegistry(): Registry {
    const tools = new Map(this.toolDefs.map((tool) => [tool.name, tool]));
    return {
      lookup: (name) => tools.get(name),
      all: () => [...tools.values()],
    };
  }

  hasTools(): boolean {
    return this.toolDefs.length > 0;
  }

  componentTypeNames(): string[] {
    return [...this.defs]
      .filter(([, entry]) => SPEC_WRITABLE_KINDS.has(entry.kind))
      .map(([name]) => name);
  }

  describe(): string {
    return this.pluginNames.length > 0 ? this.pluginNames.join(', ') : 'none';
  }

  private registerSpecComponents(plugin: HeddlePlugin): void {
    const groups: Array<[ComponentKind, PluginComponentDef[]]> = [
      ['node', plugin.nodes ?? []],
      ['transform', plugin.transforms ?? []],
      ['component', plugin.components ?? []],
      ['provider', plugin.providers ?? []],
    ];

    for (const [kind, defs] of groups) {
      for (const def of defs) this.register(kind, def, plugin);
    }
  }

  private registerMiddleware(plugin: HeddlePlugin): void {
    for (const def of plugin.middleware ?? []) {
      this.register('middleware', def, plugin);
      this.middlewares.push({ plugin: plugin.name, def });
    }
  }

  private registerEncoders(plugin: HeddlePlugin): void {
    for (const def of plugin.encoders ?? []) {
      this.register('encoder', def, plugin);
      this.claimProtocol(def, plugin.name);
      this.encoders.set(def.protocol, { plugin: plugin.name, def });
    }
  }

  private registerInputFormats(plugin: HeddlePlugin): void {
    for (const def of plugin.formats ?? []) {
      this.claimInputFormat(def, plugin.name);
      this.formats.set(def.name, { plugin: plugin.name, def });
      for (const extension of def.extensions) {
        this.formatExtensions.set(extension.toLowerCase(), def.name);
      }
    }
  }

  /**
   * At most one store, across every plugin loaded.
   *
   * Not because two could not be held, but because a process writes its
   * conversations to one place and there is no flag that would mean "both".
   * Two installed stores is a deployment that thinks it configured something it
   * did not, so it is refused at load with both names rather than silently
   * resolved by order.
   */
  private registerStores(plugin: HeddlePlugin): void {
    for (const def of plugin.stores ?? []) {
      const claimed = [...this.stores.values()][0];
      if (claimed) {
        throw new PluginError(
          duplicateStoreMessage(
            claimed.def.componentType,
            claimed.plugin,
            def.componentType,
            plugin.name,
          ),
        );
      }

      this.register('store', def, plugin);
      this.stores.set(def.componentType, { plugin: plugin.name, def });
    }
  }

  private registerTools(plugin: HeddlePlugin): void {
    for (const tool of plugin.tools ?? []) {
      const owner = this.toolOwners.get(tool.name);
      if (owner !== undefined) {
        throw new PluginError(
          duplicateToolMessage(tool.name, owner, plugin.name),
        );
      }
      this.toolOwners.set(tool.name, plugin.name);
      this.toolDefs.push(tool);
    }
  }

  /**
   * What the loaded plugins put in every workspace.
   *
   * Mounts, because that is what a workspace already knows how to take, and
   * `--mount` and a plugin then collide against each other in one namespace
   * rather than in two that have to be reconciled. Read-only without exception:
   * a plugin ships files, and a writable channel onto the operator's disk is
   * not something a manifest gets to ask for.
   */
  workspaceMounts(): Mount[] {
    return [...this.mounts];
  }

  private registerFiles(plugin: HeddlePlugin): void {
    for (const file of plugin.files ?? []) {
      const mount: Mount = {
        source: file.path,
        dest: file.dest,
        mode: 'ro',
        origin: `plugin "${plugin.name}"`,
      };
      // Every mount against every mount, by prefix rather than by equality, so
      // "skills" and "skills/extra" collide. The message names both origins,
      // which matters because one of them is usually a plugin the operator did
      // not write.
      assertNoCollisions([...this.mounts, mount]);
      this.mounts.push(mount);
    }
  }

  private register(
    kind: ComponentKind,
    def: PluginComponentDef | PluginMiddlewareDef,
    plugin: HeddlePlugin,
  ): void {
    this.claim(def.componentType, plugin.name);
    this.defs.set(def.componentType, {
      kind,
      def: def as PluginComponentDef,
      version: plugin.version,
    });
  }

  private claim(componentType: string, pluginName: string): void {
    if (this.defs.has(componentType)) {
      throw new PluginError(
        `component type "${componentType}" is provided by more than one plugin ` +
          `(re-registered by "${pluginName}"). Remove the duplicate plugin.`,
      );
    }
  }

  private claimProtocol(def: PluginEncoderDef, pluginName: string): void {
    if (typeof def.protocol !== 'string' || !PROTOCOL_NAME.test(def.protocol)) {
      throw new PluginError(malformedProtocolMessage(pluginName, def.protocol));
    }
    if (def.protocol === BUILTIN_PROTOCOL) {
      throw new PluginError(reservedProtocolMessage(pluginName));
    }
    if (typeof def.contentType !== 'string' || !def.contentType) {
      throw new PluginError(
        missingContentTypeMessage(pluginName, def.protocol),
      );
    }

    const claimed = this.encoders.get(def.protocol);
    if (claimed !== undefined) {
      throw new PluginError(
        duplicateProtocolMessage(def.protocol, claimed.plugin, pluginName),
      );
    }
  }

  /**
   * `claimProtocol`'s shape, applied to the input side.
   *
   * A format name is what `--format` writes and an extension is what a path
   * resolves through, so both live in one namespace each: a builtin name or
   * extension may not be taken (json and yaml must mean the same thing on
   * every install), and two plugins claiming the same one is refused with
   * both names rather than resolved by load order.
   */
  private claimInputFormat(def: InputFormatDef, pluginName: string): void {
    if (typeof def.name !== 'string' || !INPUT_FORMAT_NAME.test(def.name)) {
      throw new PluginError(malformedFormatMessage(pluginName, def.name));
    }
    if (BUILTIN_INPUT_FORMATS.some((builtin) => builtin.name === def.name)) {
      throw new PluginError(reservedFormatMessage(pluginName, def.name));
    }
    const claimed = this.formats.get(def.name);
    if (claimed !== undefined) {
      throw new PluginError(
        duplicateFormatMessage(def.name, claimed.plugin, pluginName),
      );
    }

    for (const extension of def.extensions ?? []) {
      this.claimFormatExtension(def, extension, pluginName);
    }
  }

  private claimFormatExtension(
    def: InputFormatDef,
    extension: string,
    pluginName: string,
  ): void {
    if (typeof extension !== 'string' || !/^\.[^./\\]+$/.test(extension)) {
      throw new PluginError(
        malformedExtensionMessage(pluginName, def.name, extension),
      );
    }

    const lower = extension.toLowerCase();
    const builtin = BUILTIN_INPUT_FORMATS.find((format) =>
      format.extensions.includes(lower),
    );
    if (builtin) {
      throw new PluginError(
        reservedExtensionMessage(pluginName, def.name, lower, builtin.name),
      );
    }

    const owner = this.formatExtensions.get(lower);
    if (owner !== undefined) {
      throw new PluginError(
        duplicateExtensionMessage(
          lower,
          this.formats.get(owner)?.plugin ?? owner,
          pluginName,
        ),
      );
    }
  }

  private defOfKind<T extends PluginComponentDef>(
    componentType: string,
    kind: ComponentKind,
  ): T | undefined {
    const entry = this.defs.get(componentType);
    return entry?.kind === kind ? (entry.def as T) : undefined;
  }
}

function assertIdentified(plugin: HeddlePlugin): void {
  if (!plugin || typeof plugin.name !== 'string' || !plugin.name) {
    throw new PluginError('plugin is missing a "name"');
  }
  if (typeof plugin.version !== 'string' || !plugin.version) {
    throw new PluginError(`plugin "${plugin.name}" is missing a "version"`);
  }
}

function duplicateToolMessage(
  toolName: string,
  owner: string,
  claimant: string,
): string {
  return (
    `plugins "${owner}" and "${claimant}" both provide the tool ` +
    `"${toolName}". A tool name is what a spec writes and what runTool ` +
    `resolves, so heddle will not guess which one a flow meant. Load one of ` +
    `them, or rename the tool in its manifest.`
  );
}

function malformedProtocolMessage(
  pluginName: string,
  protocol: unknown,
): string {
  return (
    `plugin "${pluginName}" declares an encoder whose protocol is ` +
    `${JSON.stringify(protocol)}. A protocol name is what a client puts in ` +
    `"?protocol=", so it has to match ${PROTOCOL_NAME.source} — lower-case ` +
    `letters, digits and hyphens. Try "ag-ui".`
  );
}

function reservedProtocolMessage(pluginName: string): string {
  return (
    `plugin "${pluginName}" declares an encoder for protocol ` +
    `"${BUILTIN_PROTOCOL}", which is heddle's own wire format. A client asking ` +
    `for it is asking for the frames heddle documents, so a plugin may not ` +
    `answer for it — choose a name for your own format instead.`
  );
}

function missingContentTypeMessage(
  pluginName: string,
  protocol: string,
): string {
  return (
    `plugin "${pluginName}" declares the encoder "${protocol}" with no ` +
    `"contentType". It is the response's own content type, so heddle has ` +
    `nothing to send without it — "text/event-stream" for a protocol carried ` +
    `over SSE.`
  );
}

function malformedFormatMessage(pluginName: string, name: unknown): string {
  return (
    `plugin "${pluginName}" declares an input format whose name is ` +
    `${JSON.stringify(name)}. A format name is what "--format" writes, so it ` +
    `has to match ${INPUT_FORMAT_NAME.source} — lower-case letters, digits ` +
    `and hyphens. Try "toml".`
  );
}

function reservedFormatMessage(pluginName: string, name: string): string {
  return (
    `plugin "${pluginName}" declares the input format "${name}", which is ` +
    `builtin. "json" and "yaml" have to mean the same thing on every heddle, ` +
    `so a plugin may not answer for them — choose a name for your own format ` +
    `instead.`
  );
}

function duplicateFormatMessage(
  name: string,
  owner: string,
  claimant: string,
): string {
  return (
    `plugins "${owner}" and "${claimant}" both provide the input format ` +
    `"${name}". A format name is what "--format" selects, so heddle will not ` +
    `guess which parser was meant. Load one of them, or rename the format.`
  );
}

function malformedExtensionMessage(
  pluginName: string,
  format: string,
  extension: unknown,
): string {
  return (
    `plugin "${pluginName}" declares the input format "${format}" with the ` +
    `extension ${JSON.stringify(extension)}. An extension is matched against ` +
    `the end of a path, dot included — ".toml", not "toml".`
  );
}

function reservedExtensionMessage(
  pluginName: string,
  format: string,
  extension: string,
  builtin: string,
): string {
  return (
    `plugin "${pluginName}" declares the input format "${format}" claiming ` +
    `"${extension}", which belongs to the builtin "${builtin}" format. What a ` +
    `${extension} file means may not depend on which plugins are loaded — ` +
    `use an extension of your own.`
  );
}

function duplicateExtensionMessage(
  extension: string,
  owner: string,
  claimant: string,
): string {
  return (
    `plugins "${owner}" and "${claimant}" both claim the extension ` +
    `"${extension}" for an input format. A path resolves through one parser, ` +
    `so heddle will not guess which one was meant. Load one of them, or ` +
    `drop the extension from one manifest.`
  );
}

function duplicateStoreMessage(
  owned: string,
  owner: string,
  claimed: string,
  claimant: string,
): string {
  return (
    `plugins "${owner}" and "${claimant}" both provide a session store ` +
    `("${owned}" and "${claimed}"). heddle writes its conversations to one ` +
    `place, and --session-store names which — so two installed stores is a ` +
    `deployment that configured something it did not. Load one of them.`
  );
}

function duplicateProtocolMessage(
  protocol: string,
  owner: string,
  claimant: string,
): string {
  return (
    `plugins "${owner}" and "${claimant}" both render the protocol ` +
    `"${protocol}". A protocol name is what a client asks for, so heddle ` +
    `will not guess which rendering they meant. Load one of them, or rename ` +
    `the protocol in its manifest.`
  );
}
