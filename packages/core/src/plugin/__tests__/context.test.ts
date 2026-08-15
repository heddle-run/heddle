import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State } from '../../state/state.js';
import type { Event } from '../../runner/events.js';
import type { TransformSpec } from '../../spec/types.js';
import type { Dependencies } from '../../node/types.js';
import type { ExecResult, Executor, ExecutorScope } from '../../tool/types.js';
import { PluginError } from '../../errors.js';
import { PluginNodeAdapter } from '../executor.js';
import { PluginRegistry } from '../registry.js';
import { TransformChain } from '../transform.js';
import { definePlugin } from '../types.js';
import type {
  PluginContext,
  PluginNode,
  PluginNodeDef,
  PluginResult,
  TransformContext,
} from '../types.js';

const NODE: PluginNode = {
  componentType: 'Counter',
  id: 'n_counter',
  name: 'counter',
  metadata: {},
};

function adapterFor(
  body: (ctx: PluginContext) => PluginResult | Promise<PluginResult>,
  deps: Dependencies,
  node: PluginNode = NODE,
): PluginNodeAdapter {
  const def: PluginNodeDef = {
    componentType: node.componentType,
    createExecutor: () => ({ execute: (_input, ctx) => body(ctx) }),
  };
  return new PluginNodeAdapter(node, def, deps);
}

async function runNode(
  body: (ctx: PluginContext) => PluginResult | Promise<PluginResult>,
  events: Event[] = [],
): Promise<Event[]> {
  const adapter = adapterFor(body, { eventHandler: (e) => events.push(e) });
  await adapter.execute(undefined, new State({}));
  return events;
}

function sandboxedExecutor(workspace: string): Executor {
  const executor: Executor = {
    execute: (): Promise<ExecResult> =>
      Promise.resolve({ output: {}, stderr: '' }),
    beginScope: (): ExecutorScope => ({
      executor,
      workspace,
      dispose: () => {},
    }),
  };
  return executor;
}

async function runTransform(
  body: (ctx: TransformContext) => void,
): Promise<Event[]> {
  const events: Event[] = [];
  const registry = PluginRegistry.fromPlugins([
    definePlugin({
      name: 'narrator-plugin',
      version: '1.0.0',
      transforms: [
        {
          componentType: 'Narrator',
          createTransform: () => ({
            apply: (_messages, ctx) => {
              body(ctx);
              return { action: 'pass' };
            },
          }),
        },
      ],
    }),
  ]);

  const spec: TransformSpec = { use: 'Narrator', config: {} };
  const chain = TransformChain.build(
    [spec],
    { plugins: registry, eventHandler: (e) => events.push(e) },
    'assistant',
  );

  await chain.apply('pre', [{ role: 'user', content: 'hello' }], undefined);
  return events;
}

describe('a plugin node reporting on itself', () => {
  it('emits a namespaced event carrying the payload it was given', async () => {
    const events = await runNode((ctx) => {
      ctx.emitEvent('progress', { done: 3, total: 10 });
      return { output: {} };
    });

    expect(events).toEqual([
      {
        type: 'plugin:Counter:progress',
        nodeName: 'counter',
        nodeType: 'Counter',
        data: { done: 3, total: 10 },
      },
    ]);
  });

  it('cannot emit a builtin event, whatever it names its own', async () => {
    const events = await runNode((ctx) => {
      ctx.emitEvent('flow_complete', { faked: true });
      return { output: {} };
    });

    expect(events[0].type).toBe('plugin:Counter:flow_complete');
    expect(events[0].nodeType).toBe('Counter');
  });

  it('fails the node that chose an unusable event name', async () => {
    await expect(
      runNode((ctx) => {
        ctx.emitEvent('two words');
        return { output: {} };
      }),
    ).rejects.toThrow(PluginError);
  });

  it('fails the node rather than the run when its payload is not JSON', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      runNode((ctx) => {
        ctx.emitEvent('progress', circular);
        return { output: {} };
      }),
    ).rejects.toThrow(PluginError);
  });

  it('logs with a level, attributed to the node that spoke', async () => {
    const events = await runNode((ctx) => {
      ctx.log('warn', 'the third row had no id; skipping it');
      return { output: {} };
    });

    expect(events).toEqual([
      {
        type: 'plugin_log',
        nodeName: 'counter',
        nodeType: 'Counter',
        level: 'warn',
        message: 'the third row had no id; skipping it',
      },
    ]);
  });

  it('keeps a log line out of the plugin namespace, so any client can render it', async () => {
    const events = await runNode((ctx) => {
      ctx.log('info', 'started');
      return { output: {} };
    });

    expect(events[0].type).toBe('plugin_log');
    expect(events[0].data).toBeUndefined();
  });

  it('keeps events in the order the plugin made them', async () => {
    const events = await runNode((ctx) => {
      ctx.log('info', 'first');
      ctx.emitEvent('progress', { done: 1 });
      ctx.log('info', 'third');
      return { output: {} };
    });

    expect(events.map((e) => e.type)).toEqual([
      'plugin_log',
      'plugin:Counter:progress',
      'plugin_log',
    ]);
  });
});

describe('a transform reporting on itself', () => {
  it('gets the same reporting surface a node gets', async () => {
    const events = await runTransform((ctx) => {
      ctx.emitEvent('inspected', { messages: 1 });
      ctx.log('debug', 'nothing to redact');
    });

    expect(events).toEqual([
      {
        type: 'plugin:Narrator:inspected',
        nodeName: 'assistant',
        nodeType: 'Narrator',
        data: { messages: 1 },
      },
      {
        type: 'plugin_log',
        nodeName: 'assistant',
        nodeType: 'Narrator',
        level: 'debug',
        message: 'nothing to redact',
      },
    ]);
  });

  it('attributes its events to the agent it hangs off, since it is not a node', async () => {
    const events = await runTransform((ctx) => ctx.emitEvent('inspected'));

    expect(events[0].nodeName).toBe('assistant');
    expect(events[0].nodeType).toBe('Narrator');
  });
});

describe('the directory a plugin node writes to', () => {
  it('is the one its own tools share, when there is a sandbox', async () => {
    const shared = join(tmpdir(), 'heddle-ws-pretend-session');
    let given = '';

    const adapter = adapterFor(
      (ctx) => {
        given = ctx.getWorkspace();
        return { output: {} };
      },
      { toolExecutor: sandboxedExecutor(shared) },
    );
    await adapter.execute(undefined, new State({}));

    expect(given).toBe(shared);
  });

  it('answers the same directory every time it is asked', async () => {
    const paths: string[] = [];
    const adapter = adapterFor(
      (ctx) => {
        paths.push(ctx.getWorkspace(), ctx.getWorkspace());
        return { output: {} };
      },
      {},
    );
    await adapter.execute(undefined, new State({}));

    expect(paths[0]).toBe(paths[1]);
  });

  it('exists and is writable when there is no sandbox at all', async () => {
    let readBack = '';
    const adapter = adapterFor(
      (ctx) => {
        const file = join(ctx.getWorkspace(), 'artifact.txt');
        writeFileSync(file, 'written by the plugin');
        readBack = readFileSync(file, 'utf-8');
        return { output: {} };
      },
      {},
    );
    await adapter.execute(undefined, new State({}));

    expect(readBack).toBe('written by the plugin');
  });

  it('is destroyed when the node returns, on failure as much as success', async () => {
    let path = '';
    const adapter = adapterFor(
      (ctx) => {
        path = ctx.getWorkspace();
        writeFileSync(join(path, 'artifact.txt'), 'x');
        throw new Error('the plugin gave up halfway');
      },
      {},
    );

    await expect(adapter.execute(undefined, new State({}))).rejects.toThrow(
      'the plugin gave up halfway',
    );
    expect(existsSync(path)).toBe(false);
  });

  it('is a fresh directory each time a loop comes back to the node', async () => {
    const paths: string[] = [];
    const adapter = adapterFor(
      (ctx) => {
        paths.push(ctx.getWorkspace());
        return { output: {} };
      },
      {},
    );
    await adapter.execute(undefined, new State({}));
    await adapter.execute(undefined, new State({}));

    expect(paths[0]).not.toBe(paths[1]);
    expect(existsSync(paths[1])).toBe(false);
  });

  it('is not created for a node that never asks for one', async () => {
    const node: PluginNode = { ...NODE, name: 'unaskingnode' };
    const before = readdirSync(tmpdir()).filter((e) =>
      e.startsWith(`heddle-ws-${node.name}-`),
    );

    const adapter = adapterFor(() => ({ output: {} }), {}, node);
    await adapter.execute(undefined, new State({}));

    const after = readdirSync(tmpdir()).filter((e) =>
      e.startsWith(`heddle-ws-${node.name}-`),
    );
    expect(after).toEqual(before);
  });

  it('is not offered to a transform, which has no scope to share one with', async () => {
    let ctx: TransformContext | undefined;
    await runTransform((c) => {
      ctx = c;
    });

    expect(ctx && 'getWorkspace' in ctx).toBe(false);
  });
});

describe('reporting with nobody listening', () => {
  it('still refuses a bad name, so it fails in tests and not in production', async () => {
    const def: PluginNodeDef = {
      componentType: NODE.componentType,
      createExecutor: () => ({
        execute: (_input, ctx) => {
          ctx.emitEvent('not a name');
          return { output: {} };
        },
      }),
    };
    const adapter = new PluginNodeAdapter(NODE, def, {});

    await expect(adapter.execute(undefined, new State({}))).rejects.toThrow(
      PluginError,
    );
  });
});
