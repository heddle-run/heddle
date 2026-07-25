import { AgentSpecDeserializer } from 'agentspec';
import type { ComponentBase } from 'agentspec';
import { toSpecFlow } from './adapter.js';
import type { Agent, ParsedFlow } from './types.js';
import { SpecError } from '../errors.js';

const deserializer = new AgentSpecDeserializer();

/** ParseFlow parses a JSON string into a ParsedFlow. */
export function parseFlow(data: string | Buffer): ParsedFlow {
  const str = typeof data === 'string' ? data : data.toString();
  const component = deserializer.fromJson(str) as ComponentBase;

  return toSpecFlow(component);
}

/** ParseFlowYaml parses a YAML string into a ParsedFlow. */
export function parseFlowYaml(data: string): ParsedFlow {
  const component = deserializer.fromYaml(data) as ComponentBase;

  return toSpecFlow(component);
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
export function parseComponent(data: string | Buffer): ParsedFlow | Agent {
  const str = typeof data === 'string' ? data : data.toString();
  const component = deserializer.fromJson(str) as ComponentBase;

  const ct = (component as unknown as { componentType: string }).componentType;

  switch (ct) {
    case 'Flow':
      return toSpecFlow(component);
    case 'Agent':
      return component as unknown as Agent;
    default:
      throw new SpecError(
        `unsupported top-level componentType "${ct}"`,
      );
  }
}

/** ParseComponentYaml deserializes a YAML string via the SDK. */
export function parseComponentYaml(data: string): ComponentBase {
  return deserializer.fromYaml(data) as ComponentBase;
}

/** ParseComponentJson deserializes a JSON string via the SDK. */
export function parseComponentJson(data: string | Buffer): ComponentBase {
  const str = typeof data === 'string' ? data : data.toString();
  return deserializer.fromJson(str) as ComponentBase;
}
