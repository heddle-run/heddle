import { AgentSpecDeserializer } from 'agentspec';
import type { ComponentBase } from 'agentspec';
import YAML from 'yaml';
import { toSpecFlow } from './adapter.js';
import type { Agent, ParsedFlow } from './types.js';
import { PluginRegistry } from '../plugin/registry.js';
import { substitutePluginNodes } from '../plugin/flow-preprocess.js';
import { SpecError } from '../errors.js';

const deserializer = new AgentSpecDeserializer();

/** Deserializer for a given registry. Cached so plugins are installed once. */
const deserializerCache = new WeakMap<PluginRegistry, AgentSpecDeserializer>();

function deserializerFor(registry: PluginRegistry): AgentSpecDeserializer {
  if (registry.isEmpty()) return deserializer;
  let d = deserializerCache.get(registry);
  if (!d) {
    // The SDK's plugin interface is structurally compatible; the cast avoids
    // importing its internal types.
    d = new AgentSpecDeserializer(
      registry.deserializationPlugins() as never[],
    );
    deserializerCache.set(registry, d);
  }
  return d;
}

/**
 * Deserializes a flow document, routing plugin node types around the SDK's
 * closed Flow schema when a registry provides any.
 */
function parseFlowDoc(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): ParsedFlow {
  const d = deserializerFor(registry);
  return withPluginHint(registry, () => {
    const { doc, pluginNodes, pluginTransforms } = substitutePluginNodes(
      raw,
      registry,
      (dict) => d.fromJson(JSON.stringify(dict)) as Record<string, unknown>,
    );
    const component = d.fromJson(JSON.stringify(doc)) as ComponentBase;
    return toSpecFlow(component, { registry, pluginNodes, pluginTransforms });
  });
}

/** The agentspec SDK's message when no plugin claims a component type. */
const UNKNOWN_COMPONENT_TYPE = /No plugin to deserialize component type "([^"]+)"/;

/**
 * Rewrites the SDK's bare "no plugin" error into something actionable. Without
 * this, a spec that uses a plugin type the user forgot to load fails with a
 * message that names neither the plugin flag nor what is currently loaded.
 */
function withPluginHint<T>(registry: PluginRegistry, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const match = UNKNOWN_COMPONENT_TYPE.exec(message);
    if (!match) throw err;

    throw new SpecError(
      `component type "${match[1]}" is not a builtin and no loaded plugin provides it.\n` +
        `  Loaded plugins: ${registry.describe()}\n` +
        `  If it comes from a plugin, load it with: --plugin <module>`,
      { cause: err },
    );
  }
}

function asDoc(value: unknown, source: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecError(`${source} must contain a top-level object`);
  }
  return value as Record<string, unknown>;
}

/** ParseFlow parses a JSON string into a ParsedFlow. */
export function parseFlow(
  data: string | Buffer,
  registry?: PluginRegistry,
): ParsedFlow {
  const str = typeof data === 'string' ? data : data.toString();

  if (!registry || registry.isEmpty()) {
    return withPluginHint(PluginRegistry.empty(), () => {
      const component = deserializer.fromJson(str) as ComponentBase;
      return toSpecFlow(component);
    });
  }

  return parseFlowDoc(asDoc(JSON.parse(str), 'flow JSON'), registry);
}

/** ParseFlowYaml parses a YAML string into a ParsedFlow. */
export function parseFlowYaml(
  data: string,
  registry?: PluginRegistry,
): ParsedFlow {
  if (!registry || registry.isEmpty()) {
    return withPluginHint(PluginRegistry.empty(), () => {
      const component = deserializer.fromYaml(data) as ComponentBase;
      return toSpecFlow(component);
    });
  }

  return parseFlowDoc(asDoc(YAML.parse(data), 'flow YAML'), registry);
}

/** ParseAgent parses a JSON string into an Agent. */
export function parseAgent(data: string | Buffer): Agent {
  const str = typeof data === 'string' ? data : data.toString();
  const component = deserializer.fromJson(str) as ComponentBase;

  const agent = component as unknown as Agent;
  if (agent.componentType !== 'Agent') {
    throw new SpecError(
      `expected componentType 'Agent', got "${agent.componentType}"`,
    );
  }

  return agent;
}

/** ParseComponent parses JSON and returns either a ParsedFlow or Agent. */
export function parseComponent(
  data: string | Buffer,
  registry?: PluginRegistry,
): ParsedFlow | Agent {
  const str = typeof data === 'string' ? data : data.toString();
  const component = deserializerFor(
    registry ?? PluginRegistry.empty(),
  ).fromJson(str) as ComponentBase;

  const ct = (component as unknown as { componentType: string }).componentType;

  switch (ct) {
    case 'Flow':
      return parseFlow(str, registry);
    case 'Agent':
      return component as unknown as Agent;
    default:
      throw new SpecError(
        `unsupported top-level componentType "${ct}"`,
      );
  }
}

/** ParseComponentYaml deserializes a YAML string via the SDK. */
export function parseComponentYaml(
  data: string,
  registry?: PluginRegistry,
): ComponentBase {
  const registryOrEmpty = registry ?? PluginRegistry.empty();
  if (registryOrEmpty.isEmpty()) {
    return withPluginHint(
      registryOrEmpty,
      () => deserializer.fromYaml(data) as ComponentBase,
    );
  }
  const raw = asDoc(YAML.parse(data), 'YAML');
  return deserializeAny(raw, registryOrEmpty);
}

/** ParseComponentJson deserializes a JSON string via the SDK. */
export function parseComponentJson(
  data: string | Buffer,
  registry?: PluginRegistry,
): ComponentBase {
  const str = typeof data === 'string' ? data : data.toString();
  const registryOrEmpty = registry ?? PluginRegistry.empty();
  if (registryOrEmpty.isEmpty()) {
    return withPluginHint(
      registryOrEmpty,
      () => deserializer.fromJson(str) as ComponentBase,
    );
  }
  return deserializeAny(asDoc(JSON.parse(str), 'JSON'), registryOrEmpty);
}

/**
 * Deserializes any top-level component. Flows go through the plugin-aware path
 * so that custom nodes inside them survive the SDK's Flow schema.
 */
function deserializeAny(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): ComponentBase {
  const d = deserializerFor(registry);
  return withPluginHint(registry, () => {
    const ct = raw.component_type ?? raw.componentType;
    if (ct !== 'Flow') {
      return d.fromJson(JSON.stringify(raw)) as ComponentBase;
    }
    const { doc } = substitutePluginNodes(raw, registry, (dict) =>
      d.fromJson(JSON.stringify(dict)) as Record<string, unknown>,
    );
    return d.fromJson(JSON.stringify(doc)) as ComponentBase;
  });
}
