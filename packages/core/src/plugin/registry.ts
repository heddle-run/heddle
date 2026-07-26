/**
 * PluginRegistry — the lookup table that makes heddle's closed sets open.
 *
 * The parser asks it which component types are known, the compiler asks it for an
 * executor, and the deserializer asks it for the agentspec SDK plugins to install.
 */
import type {
  HeddlePlugin,
  PluginComponentDef,
  PluginNodeDef,
  PluginTransformDef,
} from './types.js';
import {
  HeddleDeserializationPlugin,
  type SdkDeserializationPlugin,
} from './deserializer.js';
import { PluginError } from '../errors.js';

export class PluginRegistry {
  private nodeDefs = new Map<string, PluginNodeDef>();
  private transformDefs = new Map<string, PluginTransformDef>();
  private componentDefs = new Map<string, PluginComponentDef>();
  private sdkPlugins: SdkDeserializationPlugin[] = [];
  private pluginNames: string[] = [];

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

    for (const def of plugin.nodes ?? []) {
      this.claim(def.componentType, plugin.name);
      this.nodeDefs.set(def.componentType, def);
      this.componentDefs.set(def.componentType, def);
    }
    for (const def of plugin.transforms ?? []) {
      this.claim(def.componentType, plugin.name);
      this.transformDefs.set(def.componentType, def);
      this.componentDefs.set(def.componentType, def);
    }
    for (const def of plugin.components ?? []) {
      this.claim(def.componentType, plugin.name);
      this.componentDefs.set(def.componentType, def);
    }

    this.sdkPlugins.push(new HeddleDeserializationPlugin(plugin));
    this.pluginNames.push(`${plugin.name}@${plugin.version}`);
  }

  /**
   * Rejects two plugins claiming one component type. The SDK raises on this too,
   * but the message it produces does not say which plugins collided.
   */
  private claim(componentType: string, pluginName: string): void {
    if (this.componentDefs.has(componentType)) {
      throw new PluginError(
        `component type "${componentType}" is provided by more than one plugin ` +
          `(re-registered by "${pluginName}"). Remove the duplicate plugin.`,
      );
    }
  }

  isEmpty(): boolean {
    return this.componentDefs.size === 0;
  }

  hasNodeType(componentType: string): boolean {
    return this.nodeDefs.has(componentType);
  }

  nodeDef(componentType: string): PluginNodeDef | undefined {
    return this.nodeDefs.get(componentType);
  }

  nodeTypeNames(): string[] {
    return [...this.nodeDefs.keys()];
  }

  hasTransformType(componentType: string): boolean {
    return this.transformDefs.has(componentType);
  }

  transformDef(componentType: string): PluginTransformDef | undefined {
    return this.transformDefs.get(componentType);
  }

  transformTypeNames(): string[] {
    return [...this.transformDefs.keys()];
  }

  componentTypeNames(): string[] {
    return [...this.componentDefs.keys()];
  }

  /** Human-readable list of loaded plugins, for error messages. */
  describe(): string {
    return this.pluginNames.length > 0 ? this.pluginNames.join(', ') : 'none';
  }

  /** The plugins to hand to the agentspec SDK's AgentSpecDeserializer. */
  deserializationPlugins(): SdkDeserializationPlugin[] {
    return [...this.sdkPlugins];
  }
}
