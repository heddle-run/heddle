/**
 * The shared harness for the seam tests.
 *
 * `chainOf` and `policy` were declared once per seam file with only the plugin
 * name varying, and two files carried the same in-process agent scaffold. The
 * providers stay local: each seam needs a provider that misbehaves in its own
 * way, and those are the tests' subject matter rather than scaffolding.
 */
import { AgentExecutor } from '../../../node/agent.js';
import { MiddlewareChain } from '../../middleware.js';
import { PluginRegistry } from '../../registry.js';
import { State } from '../../../state/state.js';
import type { AgentStep } from '../../../spec/types.js';
import type { Event } from '../../../runner/events.js';
import type { Provider } from '../../../llm/types.js';
import type { Dependencies } from '../../../node/types.js';
import type { HeddlePlugin, PluginMiddlewareDef } from '../../types.js';

/** One in-process plugin named "policies" carrying the given middleware. */
export function pluginWith(...defs: PluginMiddlewareDef[]): HeddlePlugin {
  return { name: 'policies', version: '1.0.0', middleware: defs };
}

/** A chain built from middleware definitions alone. */
export function chainOf(...defs: PluginMiddlewareDef[]): MiddlewareChain {
  return MiddlewareChain.build(PluginRegistry.fromPlugins([pluginWith(...defs)]), {});
}

/** A middleware subscribing to `seams` with the given handlers. */
export function policy(
  seams: PluginMiddlewareDef['seams'],
  impl: Record<string, unknown>,
  componentType = 'Policy',
): PluginMiddlewareDef {
  return { componentType, seams, createMiddleware: () => impl as never };
}

/**
 * An agent with one `shell` tool, wired to the given provider and chain.
 * `toolImpl` is what the tool answers — or throws — when it actually runs.
 */
export function agentWith(
  chain: MiddlewareChain | undefined,
  provider: Provider,
  toolImpl: () => Record<string, unknown> = () => ({ ok: true }),
  extraDeps: Partial<Dependencies> = {},
): { execute: () => Promise<State>; events: Event[] } {
  const events: Event[] = [];
  const deps: Dependencies = {
    ...extraDeps,
    eventHandler: (e) => events.push(e),
    middleware: chain,
    createProvider: () => provider,
    toolRegistry: {
      lookup: (name) =>
        name === 'shell'
          ? {
              name: 'shell',
              description: '',
              origin: 'test',
              impl: {
                kind: 'plugin',
                plugin: 'test',
                call: async () => ({ output: toolImpl(), stderr: '' }),
              },
            }
          : undefined,
      all: () => [],
    },
  };

  const step: AgentStep = {
    kind: 'agent',
    name: 'assistant',
    agent: {
      model: { provider: 'openai', model: 'gpt-4o', extra: {} },
      prompt: 'do the thing',
      tools: [
        {
          name: 'shell',
          description: 'run a command',
          inputs: {},
          outputs: {},
        },
      ],
      transforms: [],
    },
  };

  const executor = new AgentExecutor(step, deps);
  return { execute: () => executor.execute(undefined, new State({})), events };
}
