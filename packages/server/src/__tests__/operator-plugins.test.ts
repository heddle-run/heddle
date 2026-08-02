/**
 * Plugins the operator installed, reached over HTTP.
 *
 * Middleware seams exist and none of them was reachable from this server:
 * `buildPlugins` loaded only what a request submitted, and a submitted plugin
 * declaring middleware is refused — correctly, since middleware runs on every
 * node of every flow and takes its settings from the command line. So the
 * component nobody can ask for was also the component nobody could install.
 *
 * What is pinned here is the whole path: a manifest on disk, loaded before the
 * port opens, consulted during a real request, and stopped when the server
 * drains. Plus the two asymmetries that make it safe to have — an installed
 * plugin is reachable whether or not request code is accepted, and a submitted
 * one cannot take a name it already provides.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadPlugins,
  withRuntime,
  type PluginRegistry,
} from '@heddle-run/core';
import { startServer, type StartedServer } from '../server.js';

/**
 * A node that fails, a policy that decides what happens next, and a tool.
 *
 * One plugin rather than three because the point is the installation, not the
 * components: what a test needs to see is that a manifest on disk reaches a
 * request, and every kind of thing that can be installed reaches it the same way.
 */
const SOURCE = `
let attempts = 0;

serve(
  {
    Boom: {
      execute: () => {
        attempts += 1;
        throw new Error('the node failed, attempt ' + attempts);
      },
    },
    Gatekeeper: {
      nodeError: {
        after: ({ subject }, ctx) =>
          ctx.component.substitute
            ? { action: 'replace', value: { rescued: ctx.component.substitute, node: subject.nodeName } }
            : { action: 'retry' },
      },
    },
  },
  { tools: { probe: () => ({ output: { reachable: true } }) } },
);
`;

const MANIFEST = {
  name: 'policies',
  version: '1.0.0',
  capabilities: [],
  components: [
    { componentType: 'Boom', kind: 'node' },
    {
      componentType: 'Gatekeeper',
      kind: 'middleware',
      seams: { nodeError: ['after'] },
      schema: {
        type: 'object',
        properties: { substitute: { type: 'string' } },
        additionalProperties: false,
      },
    },
  ],
  tools: [{ name: 'probe', componentType: 'Boom' }],
};

const FLOW = {
  component_type: 'Flow',
  name: 'policy-flow',
  start_node: { $component_ref: 'start' },
  nodes: [
    { $component_ref: 'start' },
    { $component_ref: 'boom' },
    { $component_ref: 'end' },
  ],
  control_flow_connections: [
    {
      component_type: 'ControlFlowEdge',
      name: 'start_to_boom',
      from_node: { $component_ref: 'start' },
      to_node: { $component_ref: 'boom' },
    },
    {
      component_type: 'ControlFlowEdge',
      name: 'boom_to_end',
      from_node: { $component_ref: 'boom' },
      to_node: { $component_ref: 'end' },
    },
  ],
  $referenced_components: {
    start: {
      component_type: 'StartNode',
      id: 'start',
      name: 'start',
      outputs: [{ title: 'text', type: 'string' }],
    },
    boom: {
      component_type: 'Boom',
      id: 'boom',
      name: 'boom',
      component_plugin_name: 'policies',
      component_plugin_version: '1.0.0',
    },
    end: { component_type: 'EndNode', id: 'end', name: 'end' },
  },
};

let scratch: string;
const running: StartedServer[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-operator-'));
});

afterAll(async () => {
  while (running.length > 0) await running.pop()!.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Write the plugin somewhere of its own, so each server gets a fresh process. */
function installable(label: string): string {
  const dir = join(scratch, label);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'policies.mjs'), withRuntime(SOURCE));
  const path = join(dir, 'policies.json');
  writeFileSync(path, JSON.stringify(MANIFEST));
  return path;
}

const install = (label: string): Promise<PluginRegistry> =>
  loadPlugins([installable(label)], { shared: true });

async function serve(
  label: string,
  options: Record<string, unknown> = {},
): Promise<{ base: string; started: StartedServer; plugins: PluginRegistry }> {
  const plugins = await install(label);
  const started = await startServer({
    host: '127.0.0.1',
    port: 0,
    plugins,
    log: () => {},
    ...options,
  });

  running.push(started);
  return { base: `http://127.0.0.1:${started.port}`, started, plugins };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const run = (base: string, body: Record<string, unknown> = {}) =>
  post(base, '/v1/runs', {
    flow: JSON.stringify(FLOW),
    inputs: { text: 'hello' },
    ...body,
  });

describe('an installed middleware, on a server that accepts no code at all', () => {
  let base: string;

  beforeAll(async () => {
    ({ base } = await serve('rescue', {
      pluginConfig: { Gatekeeper: { substitute: 'from the policy' } },
    }));
  });

  it('is consulted when a node fails, and its answer stands', async () => {
    const res = await run(base);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: Record<string, unknown> };
    expect(body.state).toMatchObject({ rescued: 'from the policy', node: 'boom' });
  });

  it('took its settings from the command line, which is the only place to put them', async () => {
    // The same assertion read the other way: `substitute` decided the value, and
    // nothing in the flow mentions the middleware at all.
    expect(JSON.stringify(FLOW)).not.toContain('Gatekeeper');
  });

  it('is reported by /v1/capabilities, alongside what else was installed', async () => {
    const res = await fetch(`${base}/v1/capabilities`);
    const body = (await res.json()) as {
      middleware: string[];
      tools: string[];
      allowRequestCode: boolean;
    };

    expect(body.allowRequestCode).toBe(false);
    expect(body.middleware).toEqual(['Gatekeeper']);
    expect(body.tools).toContain('probe');
  });

  it('lets /v1/validate accept a flow naming a component only it provides', async () => {
    const res = await post(base, '/v1/validate', { flow: JSON.stringify(FLOW) });

    expect(res.status).toBe(200);
    expect((await res.json()) as { valid: boolean }).toMatchObject({ valid: true });
  });
});

describe('the ceiling on what an installed middleware may ask for', () => {
  it('stops retrying a node at --max-node-attempts, and says so', async () => {
    // No `substitute`, so the policy asks to retry every time.
    const { base } = await serve('ceiling', { maxNodeAttempts: 2 });

    const res = await run(base);

    // 400 because the node's failure came out of a plugin, and a `PluginError`
    // is a caller fault by default. What this test is about is the count.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    // Twice, not three times: a ceiling a middleware can raise is not a ceiling.
    expect(body.error.message).toContain('attempt 2');
    expect(body.error.message).not.toContain('attempt 3');
  });
});

describe('what a request may not do to an installed plugin', () => {
  it('cannot claim a component type it already provides', async () => {
    const { base } = await serve('shadow', { allowRequestCode: true });

    const res = await run(base, {
      plugins: [
        {
          name: 'impostor',
          manifest: {
            name: 'impostor',
            version: '1.0.0',
            capabilities: [],
            components: [{ componentType: 'Boom', kind: 'node' }],
          },
          source: `serve({ Boom: { execute: () => ({ output: { owned: true } }) } });`,
        },
      ],
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /more than one plugin/,
    );
  });

  it('cannot raise the retry ceiling the operator set', async () => {
    const { base } = await serve('no-raise');

    const res = await run(base, { maxNodeAttempts: 99 });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /server-side configuration/,
    );
  });
});

describe('configuration that cannot be right', () => {
  it('is refused before the port opens, not on the request that needs it', async () => {
    const plugins = await install('unclaimed');

    await expect(
      startServer({
        host: '127.0.0.1',
        port: 0,
        plugins,
        pluginConfig: { RetryPolicy: { maxAttempts: 3 } },
        log: () => {},
      }),
    ).rejects.toThrow(/no loaded plugin provides as a middleware/);

    plugins.dispose();
  });

  it('is checked against the schema the plugin declared', async () => {
    const plugins = await install('mistyped');

    await expect(
      startServer({
        host: '127.0.0.1',
        port: 0,
        plugins,
        pluginConfig: { Gatekeeper: { substitue: 'a typo' } },
        log: () => {},
      }),
    ).rejects.toThrow(/substitue/);

    plugins.dispose();
  });
});

describe('the end of the server', () => {
  it('stops the plugin processes it started, which no run would have', async () => {
    const { started, plugins, base } = await serve('drain');

    // Alive first, or the assertion below would pass on a plugin that never ran.
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      status: 'ok',
    });

    await started.drain();
    running.pop();

    const probe = plugins.toolRegistry().lookup('probe');
    await expect(
      probe!.impl.kind === 'plugin'
        ? probe!.impl.call(undefined as unknown as AbortSignal, {})
        : Promise.reject(new Error('the tool is not a plugin tool')),
    ).rejects.toThrow();
  });
});
