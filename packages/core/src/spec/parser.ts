import type { ComponentBase } from 'agentspec';
import YAML from 'yaml';
import { restoreAgentTransforms, toSpecFlow } from './adapter.js';
import type { Agent, ParsedFlow } from './types.js';
import { PluginRegistry } from '../plugin/registry.js';
import { substitutePluginNodes } from '../plugin/flow-preprocess.js';
import { SpecError } from '../errors.js';

/** Default when no plugins are configured. Shared so its deserializer is reused. */
const NO_PLUGINS = PluginRegistry.empty();

function asDoc(value: unknown, source: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecError(`${source} must contain a top-level object`);
  }
  return value as Record<string, unknown>;
}

function toDoc(data: string | Buffer): Record<string, unknown> {
  const str = typeof data === 'string' ? data : data.toString();
  return asDoc(JSON.parse(str), 'JSON');
}

/**
 * Deserializes any component document.
 *
 * Every document takes this path, plugins or not: `substitutePluginNodes` walks
 * the document to swap plugin components for stand-ins the SDK's schemas accept,
 * and returns it untouched when nothing needs swapping. Keeping one path means
 * there is no plugin-specific branch to drift out of sync with the plain one.
 */
function deserialize(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): { component: ComponentBase; substitution: ReturnType<typeof substitutePluginNodes> } {
  const d = registry.deserializer();
  const substitution = substitutePluginNodes(raw, registry, (dict) =>
    d.fromJson(JSON.stringify(dict)) as Record<string, unknown>,
  );
  return {
    component: d.fromJson(JSON.stringify(substitution.doc)) as ComponentBase,
    substitution,
  };
}

/**
 * Deserializes a component and puts its real plugin transforms back.
 *
 * Every path that returns a component rather than a ParsedFlow goes through
 * here. Doing the restore at the deserialize boundary is what keeps the four
 * entry points from drifting: forgetting it in one of them is how the standalone
 * Agent came back holding stand-ins in the first place.
 */
function toComponent(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): ComponentBase {
  const { component, substitution } = deserialize(raw, registry);
  return restoreAgentTransforms(component, substitution.pluginTransforms);
}

function toFlow(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): ParsedFlow {
  const { component, substitution } = deserialize(raw, registry);
  return toSpecFlow(component, {
    registry,
    pluginNodes: substitution.pluginNodes,
    pluginTransforms: substitution.pluginTransforms,
  });
}

/** ParseFlow parses a JSON string into a ParsedFlow. */
export function parseFlow(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return toFlow(toDoc(data), registry);
}

/** ParseFlowYaml parses a YAML string into a ParsedFlow. */
export function parseFlowYaml(
  data: string,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return toFlow(asDoc(YAML.parse(data), 'YAML'), registry);
}

/** ParseAgent parses a JSON string into an Agent. */
export function parseAgent(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): Agent {
  const agent = parseComponentJson(data, registry) as unknown as Agent;
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
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow | Agent {
  const raw = toDoc(data);
  const { component, substitution } = deserialize(raw, registry);
  const ct = (component as unknown as { componentType: string }).componentType;

  switch (ct) {
    case 'Flow':
      return toSpecFlow(component, {
        registry,
        pluginNodes: substitution.pluginNodes,
        pluginTransforms: substitution.pluginTransforms,
      });
    case 'Agent':
      return restoreAgentTransforms(
        component,
        substitution.pluginTransforms,
      ) as unknown as Agent;
    default:
      throw new SpecError(`unsupported top-level componentType "${ct}"`);
  }
}

/** ParseComponentYaml deserializes a YAML string via the SDK. */
export function parseComponentYaml(
  data: string,
  registry: PluginRegistry = NO_PLUGINS,
): ComponentBase {
  return toComponent(asDoc(YAML.parse(data), 'YAML'), registry);
}

/** ParseComponentJson deserializes a JSON string via the SDK. */
export function parseComponentJson(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ComponentBase {
  return toComponent(toDoc(data), registry);
}
