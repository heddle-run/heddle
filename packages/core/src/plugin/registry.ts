import { AgentSpecDeserializer, isBuiltinComponentType } from 'agentspec';
import type { ComponentDeserializationPlugin } from 'agentspec';
import type {
  HeddlePlugin,
  PluginComponentDef,
  PluginEncoderDef,
  PluginMiddlewareDef,
  PluginNodeDef,
  PluginProviderDef,
  PluginTransformDef,
} from './types.js';
import { BUILTIN_PROTOCOL, PROTOCOL_NAME } from './encoder.js';
import { HeddleDeserializationPlugin } from './deserializer.js';
import type { PluginHost } from './host.js';
import type { Registry, ToolDef } from '../tool/types.js';
import { assertNoCollisions, type Mount } from '../workspace/index.js';
import { PluginError } from '../errors.js';

export type ComponentKind =
  | 'node'
  | 'transform'
  | 'component'
  | 'provider'
  | 'middleware'
  | 'encoder';

const SPEC_WRITABLE_KINDS: ReadonlySet<ComponentKind> = new Set<ComponentKind>([
  'node',
  'transform',
  'component',
  'provider',
]);

interface Registered {
  kind: ComponentKind;
  def: PluginComponentDef;
}

export interface RegisteredMiddleware {
  plugin: string;
  def: PluginMiddlewareDef;
}

interface RegisteredEncoder {
  plugin: string;
  def: PluginEncoderDef;
}

export class PluginRegistry {
  private readonly defs = new Map<string, Registered>();
  private readonly sdkPlugins: ComponentDeserializationPlugin[] = [];
  private readonly pluginNames: string[] = [];
  private readonly middlewares: RegisteredMiddleware[] = [];
  private readonly encoders = new Map<string, RegisteredEncoder>();
  private readonly toolDefs: ToolDef[] = [];
  private readonly toolOwners = new Map<string, string>();
  private readonly mounts: Mount[] = [];
  private hosts: PluginHost[] = [];
  private deserializerInstance: AgentSpecDeserializer | undefined;

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
    this.registerTools(plugin);
    this.registerFiles(plugin);

    this.sdkPlugins.push(new HeddleDeserializationPlugin(plugin));
    this.pluginNames.push(`${plugin.name}@${plugin.version}`);
    this.deserializerInstance = undefined;
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
    copy.sdkPlugins.push(...this.sdkPlugins);
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

  hasRemote(): boolean {
    return this.hosts.length > 0;
  }

  isEmpty(): boolean {
    return this.defs.size === 0;
  }

  kindOf(componentType: string): ComponentKind | undefined {
    return this.defs.get(componentType)?.kind;
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

  deserializer(): AgentSpecDeserializer {
    this.deserializerInstance ??= new AgentSpecDeserializer(this.sdkPlugins);
    return this.deserializerInstance;
  }

  private registerSpecComponents(plugin: HeddlePlugin): void {
    const groups: Array<[ComponentKind, PluginComponentDef[]]> = [
      ['node', plugin.nodes ?? []],
      ['transform', plugin.transforms ?? []],
      ['component', plugin.components ?? []],
      ['provider', plugin.providers ?? []],
    ];

    for (const [kind, defs] of groups) {
      for (const def of defs) this.register(kind, def, plugin.name);
    }
  }

  private registerMiddleware(plugin: HeddlePlugin): void {
    for (const def of plugin.middleware ?? []) {
      this.register('middleware', def, plugin.name);
      this.middlewares.push({ plugin: plugin.name, def });
    }
  }

  private registerEncoders(plugin: HeddlePlugin): void {
    for (const def of plugin.encoders ?? []) {
      this.register('encoder', def, plugin.name);
      this.claimProtocol(def, plugin.name);
      this.encoders.set(def.protocol, { plugin: plugin.name, def });
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
    pluginName: string,
  ): void {
    this.claim(def.componentType, pluginName);
    this.defs.set(def.componentType, {
      kind,
      def: def as PluginComponentDef,
    });
  }

  private claim(componentType: string, pluginName: string): void {
    if (isBuiltinComponentType(componentType)) {
      throw new PluginError(
        `plugin "${pluginName}" declares component type "${componentType}", ` +
          `which is a builtin Agent Spec type. Choose a different name.`,
      );
    }
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
