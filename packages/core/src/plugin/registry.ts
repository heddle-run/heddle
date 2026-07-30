/**
 * PluginRegistry — the lookup table that makes heddle's closed sets open.
 *
 * The parser asks it what a component type is, the compiler asks it for an
 * executor, and it owns the agentspec deserializer configured with its plugins.
 */
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
import { PluginError } from '../errors.js';

/** What a custom component type is, which decides how heddle handles it. */
export type ComponentKind =
  | 'node'
  | 'transform'
  | 'component'
  | 'provider'
  | 'middleware'
  | 'encoder';

interface Registered {
  kind: ComponentKind;
  def: PluginComponentDef;
}

/** One middleware, and the plugin that supplied it. */
export interface RegisteredMiddleware {
  plugin: string;
  def: PluginMiddlewareDef;
}

export class PluginRegistry {
  private defs = new Map<string, Registered>();
  private sdkPlugins: ComponentDeserializationPlugin[] = [];
  private pluginNames: string[] = [];
  private deserializerInstance: AgentSpecDeserializer | undefined;
  private hosts: PluginHost[] = [];
  /**
   * Middleware, in load order, kept as a list rather than in `defs`.
   *
   * Everything in `defs` is there to be *looked up* by the component type a
   * document wrote. Nothing looks a middleware up, because no document names
   * one — the chain is "all of them, in order", and the order is the order the
   * operator loaded the plugins in. Keeping them in the same map would imply a
   * lookup that has no caller and would put a middleware's name in
   * `componentTypeNames()`, where it would be offered to a spec author as
   * something they could write.
   */
  private middlewares: RegisteredMiddleware[] = [];
  /** Which plugin claimed each tool name, so a collision names both. */
  private toolNames = new Map<string, string>();

  /**
   * Encoders by the protocol name a request asks for, with the plugin that
   * supplied each so a collision can name both.
   *
   * A third namespace, beside component types and tool names, and it is a
   * namespace rather than a lookup in `defs` because what selects an encoder is
   * not what a document writes. `defs` answers "a spec said `X`, what is it";
   * this answers "a client asked for `ag-ui`, who renders it". The two happen to
   * be strings and share nothing else — a plugin's component may be called
   * `AgUiEncoder` while its protocol is `ag-ui`, and neither name has to know
   * about the other.
   */
  private encoders = new Map<string, { plugin: string; def: PluginEncoderDef }>();

  /**
   * Tools contributed by plugins, in load order, kept out of `defs` for the
   * same reason middleware is: `defs` exists to be looked up by a component
   * type a document wrote, and a tool name is a different namespace entirely.
   * Putting one in `defs` would offer it to a spec author as a `component_type`.
   */
  private toolDefs: ToolDef[] = [];

  /** An empty registry — the default when no plugins are configured. */
  static empty(): PluginRegistry {
    return new PluginRegistry();
  }

  static fromPlugins(plugins: HeddlePlugin[]): PluginRegistry {
    const registry = new PluginRegistry();
    for (const plugin of plugins) {
      registry.add(plugin);
    }
    return registry;
  }

  add(plugin: HeddlePlugin): void {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name) {
      throw new PluginError('plugin is missing a "name"');
    }
    if (typeof plugin.version !== 'string' || !plugin.version) {
      throw new PluginError(`plugin "${plugin.name}" is missing a "version"`);
    }

    const groups: Array<[ComponentKind, PluginComponentDef[]]> = [
      ['node', plugin.nodes ?? []],
      ['transform', plugin.transforms ?? []],
      ['component', plugin.components ?? []],
      ['provider', plugin.providers ?? []],
    ];
    for (const [kind, defs] of groups) {
      for (const def of defs) {
        this.claim(def.componentType, plugin.name);
        this.defs.set(def.componentType, { kind, def });
      }
    }

    // Claimed alongside the rest, so one plugin cannot ship a node and a
    // middleware under one name and leave which one wins to map iteration
    // order — but recorded in a list, because the chain is ordered and the map
    // is not.
    for (const def of plugin.middleware ?? []) {
      this.claim(def.componentType, plugin.name);
      this.defs.set(def.componentType, { kind: 'middleware', def });
      this.middlewares.push({ plugin: plugin.name, def });
    }

    // Claimed in `defs` like a middleware, for the same two reasons: one plugin
    // must not ship a node and an encoder under one component type and leave
    // which wins to map iteration order, and `kindOf` has to be able to tell a
    // spec author that the type they wrote is real but is not theirs to write.
    // Registered by protocol separately, because that is what selects one.
    for (const def of plugin.encoders ?? []) {
      this.claim(def.componentType, plugin.name);
      this.defs.set(def.componentType, { kind: 'encoder', def });
      this.claimProtocol(def, plugin.name);
      this.encoders.set(def.protocol, { plugin: plugin.name, def });
    }

    for (const tool of plugin.tools ?? []) {
      const claimed = this.toolNames.get(tool.name);
      // Any second claim, including one from a plugin reporting the same name.
      // A manifest's `name` is self-reported and nothing makes it unique, so
      // `claimed !== plugin.name` was an escape hatch two plugins could walk
      // through by agreeing on a string — after which the later tool silently
      // won. The same plugin object is never added twice, so the condition was
      // guarding nothing it was meant to.
      if (claimed !== undefined) {
        // Two plugins, one tool name. A load error rather than last-wins,
        // because load order is `--plugin` order and nothing about typing two
        // flags says which MCP proxy should own `search`. The operator picks by
        // dropping one, which is a decision they can see having made.
        throw new PluginError(
          `plugins "${claimed}" and "${plugin.name}" both provide the tool ` +
            `"${tool.name}". A tool name is what a spec writes and what runTool ` +
            `resolves, so heddle will not guess which one a flow meant. Load one of ` +
            `them, or rename the tool in its manifest.`,
        );
      }
      this.toolNames.set(tool.name, plugin.name);
      this.toolDefs.push(tool);
    }

    this.sdkPlugins.push(new HeddleDeserializationPlugin(plugin));
    this.pluginNames.push(`${plugin.name}@${plugin.version}`);
    this.deserializerInstance = undefined;
  }

  /**
   * Rejects a component type that is already spoken for. Shadowing a builtin
   * would otherwise surface as the SDK's opaque "multiple plugins" error, and a
   * plugin node named after a builtin would never be reached by the compiler.
   */
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

  /**
   * Rejects a protocol name a plugin may not have.
   *
   * The refusal that matters is the first one, and it is the same rule
   * `providerFor` enforces about a builtin `llm_config` type: a plugin cannot
   * become the renderer for a client that asked for heddle's own frames. That
   * client is not asking for an extension, it is asking for the thing it already
   * knows, and answering with a stranger's rendering is a capture — a `heddle`
   * stream is what a browser written against `flow_complete` is switching on.
   * Refused at load, so an operator learns of it when they load the plugin
   * rather than when a client's rendering silently changes.
   *
   * A collision between two plugins is a load error rather than last-wins for
   * `toolNames`'s reason: load order is `--plugin` order, and nothing about
   * typing two flags says which of two AG-UI implementations a client meant.
   */
  private claimProtocol(def: PluginEncoderDef, pluginName: string): void {
    if (typeof def.protocol !== 'string' || !PROTOCOL_NAME.test(def.protocol)) {
      throw new PluginError(
        `plugin "${pluginName}" declares an encoder whose protocol is ` +
          `${JSON.stringify(def.protocol)}. A protocol name is what a client puts in ` +
          `"?protocol=", so it has to match ${PROTOCOL_NAME.source} — lower-case ` +
          `letters, digits and hyphens. Try "ag-ui".`,
      );
    }
    if (def.protocol === BUILTIN_PROTOCOL) {
      throw new PluginError(
        `plugin "${pluginName}" declares an encoder for protocol ` +
          `"${BUILTIN_PROTOCOL}", which is heddle's own wire format. A client asking ` +
          `for it is asking for the frames heddle documents, so a plugin may not ` +
          `answer for it — choose a name for your own format instead.`,
      );
    }
    if (typeof def.contentType !== 'string' || !def.contentType) {
      throw new PluginError(
        `plugin "${pluginName}" declares the encoder "${def.protocol}" with no ` +
          `"contentType". It is the response's own content type, so heddle has ` +
          `nothing to send without it — "text/event-stream" for a protocol carried ` +
          `over SSE.`,
      );
    }
    const claimed = this.encoders.get(def.protocol);
    if (claimed !== undefined) {
      throw new PluginError(
        `plugins "${claimed.plugin}" and "${pluginName}" both render the protocol ` +
          `"${def.protocol}". A protocol name is what a client asks for, so heddle ` +
          `will not guess which rendering they meant. Load one of them, or rename ` +
          `the protocol in its manifest.`,
      );
    }
  }

  /**
   * Register a plugin that runs in its own process, and take ownership of that
   * process.
   *
   * The registry owns it because the registry's lifetime is already the right
   * one: it is built per run wherever plugins are untrusted, so disposing it
   * disposes them.
   */
  addRemote(remote: { plugin: HeddlePlugin; host: PluginHost }): void {
    this.add(remote.plugin);
    this.hosts.push(remote.host);
  }

  /**
   * Stop every plugin process this registry started.
   *
   * Must run at the end of a run, on every path. This is the step that stops
   * one caller's code from outliving their request — the guarantee the
   * in-process API cannot make, because there is nothing to stop.
   */
  dispose(): void {
    for (const host of this.hosts) host.dispose();
    this.hosts = [];
  }

  /** True when any registered plugin runs out of process. */
  hasRemote(): boolean {
    return this.hosts.length > 0;
  }

  isEmpty(): boolean {
    return this.defs.size === 0;
  }

  /** What kind of component this type is, or undefined if no plugin provides it. */
  kindOf(componentType: string): ComponentKind | undefined {
    return this.defs.get(componentType)?.kind;
  }

  nodeDef(componentType: string): PluginNodeDef | undefined {
    const entry = this.defs.get(componentType);
    return entry?.kind === 'node' ? (entry.def as PluginNodeDef) : undefined;
  }

  transformDef(componentType: string): PluginTransformDef | undefined {
    const entry = this.defs.get(componentType);
    return entry?.kind === 'transform'
      ? (entry.def as PluginTransformDef)
      : undefined;
  }

  /**
   * The provider for a custom `llm_config` type, if a plugin supplies one.
   *
   * Read only by `providerFor`, and only after it has established the type is
   * not a builtin — so this is never consulted for `OpenAiConfig` even though
   * {@link claim} would already have refused a plugin that named it.
   */
  providerDef(componentType: string): PluginProviderDef | undefined {
    const entry = this.defs.get(componentType);
    return entry?.kind === 'provider'
      ? (entry.def as PluginProviderDef)
      : undefined;
  }

  /**
   * Every middleware, in the order its plugin was loaded.
   *
   * Load order is the only ordering there is, and it is the operator's: they
   * chose the sequence of `--plugin` flags. That makes the chain's behaviour
   * something an operator can change without touching a plugin or a flow, which
   * is the right lever for a component nobody's document mentions.
   */
  middlewareDefs(): RegisteredMiddleware[] {
    return this.middlewares;
  }

  /**
   * The encoder for a protocol, if a plugin renders it.
   *
   * Never asked about {@link BUILTIN_PROTOCOL}: its caller resolves heddle's own
   * name first, and {@link claimProtocol} refused a plugin that tried to take
   * it. Both halves, for `providerFor`'s reason — the load-time refusal is the
   * message an author gets, and the lookup order is the guarantee.
   */
  encoderDef(protocol: string): PluginEncoderDef | undefined {
    return this.encoders.get(protocol)?.def;
  }

  /**
   * Every protocol a loaded plugin renders, for a client asking what it may
   * request and for the error shown to one that asked for something else.
   *
   * heddle's own is not in here. This is what plugins add, and the caller
   * assembling the answer is the one that knows the builtin exists.
   */
  encoderProtocols(): string[] {
    return [...this.encoders.keys()].sort();
  }

  /**
   * The tools every loaded plugin contributes, as a Registry.
   *
   * Synchronous by construction: everything in it came out of a manifest, which
   * is data, so nothing here starts a process or crosses a pipe. That is the
   * property `Registry.lookup` needs and the reason tools are declared rather
   * than discovered.
   */
  toolRegistry(): Registry {
    const tools = new Map(this.toolDefs.map((tool) => [tool.name, tool]));
    return {
      lookup: (name) => tools.get(name),
      all: () => [...tools.values()],
    };
  }

  /** Whether any loaded plugin contributes a tool at all. */
  hasTools(): boolean {
    return this.toolDefs.length > 0;
  }

  /**
   * The component types a spec may write.
   *
   * Middleware and encoders are excluded on purpose. This list is what the
   * parser offers a spec author who named a type nothing provides, and neither
   * kind is something they can name — suggesting one would send them to write a
   * `component_type` the deserializer will reject. They are the two kinds nobody's
   * document mentions: one the operator installs, one the request selects.
   */
  componentTypeNames(): string[] {
    return [...this.defs]
      .filter(([, entry]) => entry.kind !== 'middleware' && entry.kind !== 'encoder')
      .map(([name]) => name);
  }

  /** Human-readable list of loaded plugins, for error messages. */
  describe(): string {
    return this.pluginNames.length > 0 ? this.pluginNames.join(', ') : 'none';
  }

  /** The agentspec deserializer configured with this registry's plugins. */
  deserializer(): AgentSpecDeserializer {
    this.deserializerInstance ??= new AgentSpecDeserializer(this.sdkPlugins);
    return this.deserializerInstance;
  }
}
