import type { ComponentBase } from 'agentspec';
import YAML from 'yaml';
import { toSpecFlow } from './adapter.js';
import type { Agent, ParsedFlow } from './types.js';
import { PluginRegistry } from '../plugin/registry.js';
import { checkPluginComponents } from '../plugin/flow-preprocess.js';
import { installWidenedUnions } from './open-unions.js';
import { SpecError } from '../errors.js';

installWidenedUnions();

const NO_PLUGINS = PluginRegistry.empty();

/**
 * Parse a JSON Agent Spec flow document. Parsing only — `loadFlow` is this
 * plus reading the file and `validateFlow`. The registry is how a document
 * naming plugin component types parses; without it they are unknown types.
 */
export function parseFlow(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return toFlow(jsonDocument(data), registry);
}

/** {@link parseFlow} for a YAML document. */
export function parseFlowYaml(
  data: string,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return toFlow(yamlDocument(data), registry);
}

/**
 * `parseFlow` for a document that is already a parsed value.
 *
 * What a server holding a request body wants: the body arrived as JSON and was
 * parsed once by the transport, so serializing it again just to parse it back
 * is a round trip that proves nothing.
 */
export function parseFlowObject(
  raw: unknown,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return toFlow(asDocument(raw, 'JSON'), registry);
}

/**
 * Parse a JSON document that must be a standalone Agent, and refuse anything
 * else by componentType — the caller who wants "whatever this is" uses
 * {@link parseComponent}.
 */
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

/**
 * Parse a JSON document that is either a Flow or an Agent, telling the two
 * apart by componentType — for the surface that accepts both and dispatches
 * afterwards. Anything else at the top level is a `SpecError`.
 */
export function parseComponent(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow | Agent {
  const component = deserialize(jsonDocument(data), registry);
  const componentType = (component as unknown as { componentType: string })
    .componentType;

  switch (componentType) {
    case 'Flow':
      return toSpecFlow(component, { registry });
    case 'Agent':
      return component as unknown as Agent;
    default:
      throw new SpecError(
        `unsupported top-level componentType "${componentType}"`,
      );
  }
}

/**
 * Parse any single Agent Spec component from YAML, without deciding what it
 * is — the raw deserializer, for the caller that dispatches on the result.
 */
export function parseComponentYaml(
  data: string,
  registry: PluginRegistry = NO_PLUGINS,
): ComponentBase {
  return deserialize(yamlDocument(data), registry);
}

/** {@link parseComponentYaml} for a JSON document. */
export function parseComponentJson(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ComponentBase {
  return deserialize(jsonDocument(data), registry);
}

function toFlow(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): ParsedFlow {
  return toSpecFlow(deserialize(raw, registry), { registry });
}

function deserialize(
  raw: Record<string, unknown>,
  registry: PluginRegistry,
): ComponentBase {
  checkPluginComponents(raw, registry);
  return registry.deserializer().fromJson(JSON.stringify(raw)) as ComponentBase;
}

function jsonDocument(data: string | Buffer): Record<string, unknown> {
  const text = typeof data === 'string' ? data : data.toString();
  return asDocument(JSON.parse(text), 'JSON');
}

function yamlDocument(data: string): Record<string, unknown> {
  return asDocument(YAML.parse(data), 'YAML');
}

function asDocument(value: unknown, format: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecError(`${format} must contain a top-level object`);
  }
  return value as Record<string, unknown>;
}
