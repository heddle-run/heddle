/**
 * A plugin process that outlives the run that used it.
 *
 * The CLI loads a plugin and runs one flow with it, so "the plugin's tools" and
 * "this run's tools" are the same set and nothing has to tell them apart. A
 * server installs a plugin once and reaches it from every request, which buys
 * the thing worth buying — a session, a pool, a warm cache survives between runs
 * — and costs the host its one piece of run-scoped state.
 *
 * Two properties are pinned here. A registry can be layered for one run without
 * that run being able to stop the processes it did not start; and a shared host
 * answers no request that does not say which run it belongs to.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRemotePlugin } from '../remote-loader.js';
import { PluginRegistry } from '../registry.js';
import { withRuntime } from '../runtime-source.js';
import { PLUGIN_CAPABILITIES, PROTOCOL_VERSION } from '../protocol.js';
import type { PluginHost } from '../host.js';

let scratch: string;
const open: Array<{ dispose: () => void }> = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-shared-'));
});

afterAll(() => {
  while (open.length > 0) open.pop()!.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/** A plugin whose one tool answers with a constant, so a call is a round trip. */
function pinger(name: string): ReturnType<typeof loadRemotePlugin> {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });

  const entry = join(dir, 'plugin.mjs');
  writeFileSync(
    entry,
    withRuntime(
      `serve({}, { tools: { ${name}: () => ({ output: { pong: '${name}' } }) } });`,
    ),
  );

  return loadRemotePlugin(
    {
      name,
      version: '1.0.0',
      capabilities: [],
      components: [{ componentType: 'Ping', kind: 'node' }],
      tools: [{ name, componentType: 'Ping' }],
    },
    entry,
    { shared: true, capabilities: PLUGIN_CAPABILITIES },
  );
}

async function ping(registry: PluginRegistry, tool: string): Promise<unknown> {
  const def = registry.toolRegistry().lookup(tool);
  expect(def, `"${tool}" is not in this registry`).toBeDefined();

  return def!.impl.kind === 'plugin'
    ? def!.impl.call(undefined as unknown as AbortSignal, {})
    : undefined;
}

describe('a registry layered for one run', () => {
  it('resolves everything the installed one holds', () => {
    const base = PluginRegistry.empty();
    base.addRemote(pinger('installed_a'));
    open.push(base);

    const perRun = base.extend();

    expect(perRun.kindOf('Ping')).toBe('node');
    expect(perRun.toolRegistry().lookup('installed_a')).toBeDefined();
    expect(perRun.describe()).toContain('installed_a@1.0.0');
  });

  it('refuses a submitted plugin claiming a name the installed one provides', () => {
    const base = PluginRegistry.empty();
    base.addRemote(pinger('installed_b'));
    open.push(base);

    const perRun = base.extend();

    expect(() =>
      perRun.add({
        name: 'submitted',
        version: '1.0.0',
        // Never called: `claim` refuses the name before anything is built.
        nodes: [
          {
            componentType: 'Ping',
            createExecutor: () => {
              throw new Error('the duplicate name should have been refused');
            },
          },
        ],
      }),
    ).toThrow(/more than one plugin/);
  });

  it('leaves the installed processes running when the run ends', async () => {
    const base = PluginRegistry.empty();
    base.addRemote(pinger('installed_c'));
    open.push(base);

    // A run: layer, use, dispose. Twice, because the second one is the one that
    // would fail if the first had taken the process with it.
    for (const attempt of [1, 2]) {
      const perRun = base.extend();
      expect(await ping(perRun, 'installed_c'), `run ${attempt}`).toMatchObject({
        output: { pong: 'installed_c' },
      });
      perRun.dispose();
    }

    expect(await ping(base, 'installed_c')).toMatchObject({ output: { pong: 'installed_c' } });
  });

  it('stops them when the server itself is done', async () => {
    const base = PluginRegistry.empty();
    base.addRemote(pinger('installed_d'));

    expect(await ping(base, 'installed_d')).toMatchObject({ output: { pong: 'installed_d' } });
    base.dispose();

    await expect(ping(base, 'installed_d')).rejects.toThrow();
  });
});

/**
 * A plugin that speaks the protocol itself, because the runtime will not do the
 * wrong thing on request.
 *
 * `ctx.runTool` always names the call it was made inside, so a plugin written
 * against the runtime cannot produce an unattributed request. This one writes
 * the frame by hand — which is what any plugin in another language could also
 * do, and the reason the host has to answer the question rather than trusting
 * the runtime to have asked it properly.
 */
function unattributed(name: string): string {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });

  const entry = join(dir, 'plugin.mjs');
  writeFileSync(
    entry,
    `const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buffer = '';
let awaiting;

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let cut = buffer.indexOf('\\n'); cut >= 0; cut = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === 'init') {
    send({ id: message.id, result: { protocol: ${PROTOCOL_VERSION} } });
    return;
  }

  if (message.method === 'execute') {
    awaiting = message.id;
    // Deliberately no "call": this is the frame a shared host must not serve.
    const params = { name: 'anything', input: {} };
    if (message.params.input.attribute) params.call = message.id;
    send({ id: 'probe', method: 'runTool', params });
    return;
  }

  if (message.id === 'probe') {
    send({
      id: awaiting,
      result: { output: { answer: message.error ? message.error.message : 'served' } },
    });
  }
}
`,
  );

  return entry;
}

function prober(name: string, shared: boolean): PluginHost {
  const { host } = loadRemotePlugin(
    {
      name,
      version: '1.0.0',
      capabilities: ['runTool'],
      components: [{ componentType: 'Prober', kind: 'node' }],
    },
    unattributed(name),
    { shared, capabilities: PLUGIN_CAPABILITIES },
  );

  open.push(host);
  return host;
}

const execute = (host: PluginHost, input: Record<string, unknown>) =>
  host.call(
    'execute',
    { componentType: 'Prober', node: { name: 'probe' }, input },
    { runTool: async () => ({ from: 'this run' }) },
  ) as Promise<{ output: { answer: string } }>;

describe('a plugin process serving one run', () => {
  it('answers an unattributed runTool from the runner it was given', async () => {
    const host = prober('single', false);
    host.setToolRunner(async () => ({ from: 'the only run there is' }));

    const result = await execute(host, {});

    expect(result.output.answer).toBe('served');
  });

  it('stays dead once its process is gone, because the run is over too', async () => {
    const host = suicidal('one-shot', false);

    await expect(execute(host, {})).rejects.toThrow(/exited/);
    await expect(execute(host, {})).rejects.toThrow(/exited/);
  });
});

/**
 * A plugin that kills itself the first time it is asked to do anything.
 *
 * The marker is a file rather than a variable, because a variable dies with the
 * process and this test is about what happens to the *next* one.
 */
function suicidal(name: string, shared: boolean): PluginHost {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });

  const entry = join(dir, 'plugin.mjs');
  writeFileSync(
    entry,
    withRuntime(
      `serve({
  Prober: {
    execute: async () => {
      const fs = await import('node:fs');
      const marker = ${JSON.stringify(join(dir, 'died-once'))};
      if (!fs.existsSync(marker)) {
        fs.writeFileSync(marker, 'x');
        process.exit(7);
      }
      return { output: { answer: 'alive again' } };
    },
  },
});`,
    ),
  );

  const { host } = loadRemotePlugin(
    {
      name,
      version: '1.0.0',
      capabilities: [],
      components: [{ componentType: 'Prober', kind: 'node' }],
    },
    entry,
    { shared, capabilities: PLUGIN_CAPABILITIES },
  );

  open.push(host);
  return host;
}

describe('a plugin process serving every run', () => {
  it('refuses an unattributed runTool rather than guessing whose it is', async () => {
    const host = prober('shared', true);

    const result = await execute(host, {});

    expect(result.output.answer).toMatch(/runTool needs a "call"/);
    expect(result.output.answer).toMatch(/one process serves every run/);
  });

  it('serves one that names the call it was made inside', async () => {
    const host = prober('attributed', true);

    const result = await execute(host, { attribute: true });

    expect(result.output.answer).toBe('served');
  });

  it('starts over after its process dies, rather than failing every later run', async () => {
    const host = suicidal('respawn', true);

    // The call that was in flight when it died still fails: it was mid-
    // conversation with a process that is gone, and there is nothing to hand it.
    await expect(execute(host, {})).rejects.toThrow(/exited/);

    // The next one is a different run, and gets a working plugin. Without this,
    // one bad minute would fail every request for the life of the server while
    // /readyz went on saying ok.
    const result = await execute(host, {});
    expect(result.output.answer).toBe('alive again');
  });

  it('takes no run-scoped runner, so nothing can latch one onto it', async () => {
    const host = prober('unlatchable', true);
    // What a component's executor does on the way in. On a shared host it has to
    // be a no-op, or the first run through would leave its tools behind for the
    // rest of the server's life.
    host.setToolRunner(async () => ({ from: 'the first run to get here' }));

    const result = await execute(host, {});

    expect(result.output.answer).toMatch(/runTool needs a "call"/);
  });
});
