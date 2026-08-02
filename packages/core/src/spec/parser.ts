import type { ComponentBase } from 'agentspec';
import { toSpecFlow } from './adapter.js';
import type { Agent, ParsedFlow } from './types.js';
import { PluginRegistry } from '../plugin/registry.js';
import { checkPluginComponents } from '../plugin/flow-preprocess.js';
import { installWidenedUnions } from './open-unions.js';
import {
  JSON_INPUT_FORMAT,
  YAML_INPUT_FORMAT,
  type InputFormatDef,
} from './input-format.js';
import { SpecError } from '../errors.js';

installWidenedUnions();

const NO_PLUGINS = PluginRegistry.empty();

/**
 * `parseFlow` through any input format — the seam every entry point below is
 * a fixed-format wrapper over. The format turns text into an Agent Spec
 * document; everything after that is one shared pipeline.
 */
export function parseFlowWith(
  format: InputFormatDef,
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return toFlow(documentOf(format, data), registry);
}

export function parseFlow(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return parseFlowWith(JSON_INPUT_FORMAT, data, registry);
}

export function parseFlowYaml(
  data: string,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return parseFlowWith(YAML_INPUT_FORMAT, data, registry);
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
  const component = deserialize(documentOf(JSON_INPUT_FORMAT, data), registry);
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

export function parseComponentWith(
  format: InputFormatDef,
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ComponentBase {
  return deserialize(documentOf(format, data), registry);
}

export function parseComponentYaml(
  data: string,
  registry: PluginRegistry = NO_PLUGINS,
): ComponentBase {
  return parseComponentWith(YAML_INPUT_FORMAT, data, registry);
}

export function parseComponentJson(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ComponentBase {
  return parseComponentWith(JSON_INPUT_FORMAT, data, registry);
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

function documentOf(
  format: InputFormatDef,
  data: string | Buffer,
): Record<string, unknown> {
  const text = typeof data === 'string' ? data : data.toString();
  return asDocument(format.parse(text), format.name.toUpperCase());
}

function asDocument(value: unknown, format: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SpecError(`${format} must contain a top-level object`);
  }
  return value as Record<string, unknown>;
}
