/**
 * The shared harness for tests that run a plugin in another process.
 *
 * Four files used to carry their own copy of the NDJSON protocol loop, the
 * scratch-directory pair and the open-registries disposal list; the copies had
 * drifted only in local names. The two loops that differ *semantically* are
 * both here, under names that say what they are:
 *
 * - `PREAMBLE` answers `handle(msg)` request/response and can call back into
 *   the host (`callHost`, `runTool`), which is what remote/reporting need.
 * - `LOOP` hands every raw frame to `onMessage(msg)` and answers nothing on
 *   its own, which is what the lifecycle tests need to misbehave on purpose.
 */
import { beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRuntime } from '../../runtime-source.js';
import type { PluginMethod } from '../../protocol.js';

/**
 * Request/response protocol loop: `handle(msg)` is asked, its return value is
 * the result, and `callHost`/`runTool`/`sleep` are in scope for the body.
 */
export const PREAMBLE = `
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const waiting = new Map();
let nextId = 0;
const callHost = (method, params) => new Promise((res, rej) => {
  const id = 'h' + nextId++;
  waiting.set(id, { res, rej });
  send({ id, method, params });
});
const runTool = (name, input) => callHost('runTool', { name, input });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.stdin.setEncoding('utf-8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (!msg.method) {
      const p = waiting.get(String(msg.id));
      if (p) { waiting.delete(String(msg.id));
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
      continue;
    }
    try { send({ id: msg.id, result: await handle(msg) }); }
    catch (e) { send({ id: msg.id, error: { message: String(e && e.message || e) } }); }
  }
});
`;

/**
 * Raw frame loop: every parsed frame reaches `onMessage(msg)` and nothing is
 * answered automatically — the body owns the whole conversation, handshake
 * included.
 */
export const LOOP = `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim()) void onMessage(JSON.parse(line));
  }
});
`;

export const ALL_CAPABILITIES: PluginMethod[] = ['runTool', 'emitEvent', 'log'];

export interface Scratch {
  /** The directory itself, for tests that need a path of their own. */
  readonly path: string;
  /** A plugin whose `handle(msg)` body answers each request (PREAMBLE). */
  writePlugin(name: string, handleBody: string): string;
  /** A plugin whose `onMessage(msg)` body sees every raw frame (LOOP). */
  writeLoopPlugin(name: string, body: string): string;
  /** A plugin written against the inlined `serve()` runtime helper. */
  writeHelperPlugin(name: string, source: string): string;
  /** A plugin whose source is taken exactly as given. */
  writeRawPlugin(name: string, source: string): string;
}

/**
 * A scratch directory made before the file's tests and removed after them.
 * Call at module scope, like the vitest hooks it registers.
 */
export function useScratch(prefix: string): Scratch {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, source: string): string => {
    const entry = join(dir, `${name}.mjs`);
    writeFileSync(entry, source);
    return entry;
  };

  return {
    get path() {
      return dir;
    },
    writePlugin: (name, handleBody) =>
      write(name, `${PREAMBLE}\nasync function handle(msg) {\n${handleBody}\n}\n`),
    writeLoopPlugin: (name, body) =>
      write(name, `${LOOP}\nasync function onMessage(msg) {\n${body}\n}\n`),
    writeHelperPlugin: (name, source) => write(name, withRuntime(source)),
    writeRawPlugin: write,
  };
}

/**
 * A list of things to dispose after each test — registries, hosts, anything
 * with a `dispose()`. Call at module scope; `track` from anywhere.
 */
export function useDisposal<
  T extends { dispose(): void } = { dispose(): void },
>(): {
  track<U extends T>(item: U): U;
} {
  const open: T[] = [];

  afterEach(() => {
    while (open.length) open.pop()!.dispose();
  });

  return {
    track(item) {
      open.push(item);
      return item;
    },
  };
}

/** A one-component manifest, the shape nearly every one of these tests wants. */
export function manifest(
  componentType: string,
  extra: Record<string, unknown> = {},
  capabilities: string[] = [],
  name = 'test-plugin',
): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    capabilities,
    components: [{ componentType, ...extra }],
  };
}

/** start → p → end, where `p` is the plugin's node under test. */
export function flowUsing(
  componentType: string,
  node: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    component_type: 'Flow',
    name: 'plugin-flow',
    start_node: { $component_ref: 's' },
    nodes: [{ $component_ref: 's' }, { $component_ref: 'p' }, { $component_ref: 'e' }],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'a',
        from_node: { $component_ref: 's' },
        to_node: { $component_ref: 'p' },
      },
      {
        component_type: 'ControlFlowEdge',
        name: 'b',
        from_node: { $component_ref: 'p' },
        to_node: { $component_ref: 'e' },
      },
    ],
    $referenced_components: {
      s: {
        component_type: 'StartNode',
        id: 's',
        name: 's',
        outputs: [{ title: 'text', type: 'string' }],
      },
      p: { component_type: componentType, id: 'p', name: 'p', ...node },
      e: { component_type: 'EndNode', id: 'e', name: 'e' },
    },
  });
}
