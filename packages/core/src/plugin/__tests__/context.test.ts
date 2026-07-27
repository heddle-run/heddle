/**
 * What a plugin can say and reach while it is running.
 *
 * Before this, a plugin node was silent between `node_start` and
 * `node_complete` and a transform was silent altogether: `PluginContext` was
 * `{ signal, node, runTool }` and `TransformContext` could not reach anything
 * at all. These tests hold the three things that widening has to keep true —
 * that both kinds get the same reporting surface, that neither can use it to
 * say something only heddle is entitled to say, and that the directory a node
 * is handed is the one its own tools can see rather than a private scratch
 * space that would fail only under a sandbox.
 */
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

/** Builds an adapter around one plugin node body. */
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

/** Runs one plugin node body, collecting whatever it emitted on the way. */
async function runNode(
  body: (ctx: PluginContext) => PluginResult | Promise<PluginResult>,
  events: Event[] = [],
): Promise<Event[]> {
  const adapter = adapterFor(body, { eventHandler: (e) => events.push(e) });
  await adapter.execute(undefined, new State({}));
  return events;
}

/**
 * An executor whose scopes carry a workspace, as a sandboxed one's do.
 *
 * Standing in for a real sandbox because the property under test is which
 * directory the plugin is told about, not whether bwrap confines anything —
 * and because the sandbox backends need a Linux or macOS host to construct.
 */
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

/** Runs one transform body through the chain that an agent would build. */
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

  const spec: TransformSpec = { componentType: 'Narrator', name: 'narrator' };
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

    // The claim a client acts on — "the run is over" — is untouched: what
    // arrived is an event of the plugin's, with the plugin's name on it.
    expect(events[0].type).toBe('plugin:Counter:flow_complete');
    expect(events[0].nodeType).toBe('Counter');
  });

  it('fails the node that chose an unusable event name', async () => {
    // Not dropped and not sanitized: the plugin is wrong, and it is the only
    // thing that can fix it.
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

    // Left to `JSON.stringify` in the server's SSE writer, this throws on the
    // runner's stack and takes down every observer of the run.
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
    // The whole difference between `log` and `emitEvent`: this payload is
    // heddle's shape, so a client renders it without knowing the plugin.
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

    // `nodeName` is a position in the graph, and a transform has none of its
    // own. Which transform spoke is in `nodeType` and in the type itself.
    expect(events[0].nodeName).toBe('assistant');
    expect(events[0].nodeType).toBe('Narrator');
  });
});

describe('the directory a plugin node writes to', () => {
  it('is the one its own tools share, when there is a sandbox', async () => {
    // The reason this exists. A plugin that made its own temp directory would
    // hand `runTool` a path that does not exist inside the tool's confinement;
    // this is the one path that means the same thing on both sides.
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

    // A plugin that wrote a file on one call and read it back on another would
    // otherwise be looking in a directory it had never written to.
    expect(paths[0]).toBe(paths[1]);
  });

  it('exists and is writable when there is no sandbox at all', async () => {
    // The unsandboxed run is the one every plugin author develops against, so
    // it has to behave the same as the confined one or the confined path is
    // the only one nobody exercises.
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
    // Without this a server running one flow a second accumulates a directory
    // per plugin node per run, and the ones from failed runs are the largest.
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

    // The first is already gone, so reusing its path would hand the second
    // execution a directory that is not there.
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

    // Most plugin nodes never touch a file. Creating and removing a directory
    // for each of them is work done for nothing, once per node per run.
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

    // A transform's tool calls each get a throwaway session, so there is no
    // directory two of them would agree on. Handing one over anyway would be a
    // temp directory with heddle's name on it and no sharing behind it.
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
    // No eventHandler at all — the CLI's default, and every embedder's.
    const adapter = new PluginNodeAdapter(NODE, def, {});

    await expect(adapter.execute(undefined, new State({}))).rejects.toThrow(
      PluginError,
    );
  });
});
