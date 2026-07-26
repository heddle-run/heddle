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
  PluginNodeDef,
  PluginTransformDef,
} from './types.js';
import { HeddleDeserializationPlugin } from './deserializer.js';
import { PluginError } from '../errors.js';

/** What a custom component type is, which decides how heddle handles it. */
export type ComponentKind = 'node' | 'transform' | 'component';

interface Registered {
  kind: ComponentKind;
  def: PluginComponentDef;
}

export class PluginRegistry {
  private defs = new Map<string, Registered>();
  private sdkPlugins: ComponentDeserializationPlugin[] = [];
  private pluginNames: string[] = [];
  private deserializerInstance: AgentSpecDeserializer | undefined;

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
    ];
    for (const [kind, defs] of groups) {
      for (const def of defs) {
        this.claim(def.componentType, plugin.name);
        this.defs.set(def.componentType, { kind, def });
      }
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

  componentTypeNames(): string[] {
    return [...this.defs.keys()];
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
