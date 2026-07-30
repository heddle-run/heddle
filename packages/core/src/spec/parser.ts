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

export function parseFlow(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return toFlow(jsonDocument(data), registry);
}

export function parseFlowYaml(
  data: string,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return toFlow(yamlDocument(data), registry);
}

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

export function parseComponentYaml(
  data: string,
  registry: PluginRegistry = NO_PLUGINS,
): ComponentBase {
  return deserialize(yamlDocument(data), registry);
}

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
