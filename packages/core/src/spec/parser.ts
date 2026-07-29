import type { ComponentBase } from 'agentspec';
import YAML from 'yaml';
import { toSpecFlow } from './adapter.js';
import type { Agent, ParsedFlow } from './types.js';
import { PluginRegistry } from '../plugin/registry.js';
import { checkPluginComponents } from '../plugin/flow-preprocess.js';
import { installWidenedUnions } from './open-unions.js';
import { SpecError } from '../errors.js';

// At module scope, before any parse can happen: the SDK's node and transform
// unions are closed until something widens them, and this is the something.
// Called rather than imported for its side effect so nothing can drop it as
// unused. See `spec/open-unions.ts` for why the widening is plugin-independent.
installWidenedUnions();

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
 * One SDK call now, where there used to be one per plugin component plus one
 * for the rewritten document. `checkPluginComponents` walks the document first
 * and only to *report* — a component type nothing provides, or one a plugin
 * provides as middleware, which no document may name. It rewrites nothing:
 * the widened unions accept the real component, so the SDK deserializes it in
 * place through the plugin path it has always had.
 *
 * Reporting before the SDK sees the document is what keeps the message good.
 * The SDK's own refusal is `No plugin to deserialize component type "X"`, which
 * is true and tells an author nothing about which plugins are loaded or how to
 * load another.
 */
function deserialize(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): ComponentBase {
  checkPluginComponents(raw, registry);
  return registry.deserializer().fromJson(JSON.stringify(raw)) as ComponentBase;
}

function toComponent(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): ComponentBase {
  return deserialize(raw, registry);
}

function toFlow(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): ParsedFlow {
  return toSpecFlow(deserialize(raw, registry), { registry });
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
  const component = deserialize(raw, registry);
  const ct = (component as unknown as { componentType: string }).componentType;

  switch (ct) {
    case 'Flow':
      return toSpecFlow(component, { registry });
    case 'Agent':
      // Nothing to restore. The SDK holds the real transform, because the
      // widened union let it through in the first place.
      return component as unknown as Agent;
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
