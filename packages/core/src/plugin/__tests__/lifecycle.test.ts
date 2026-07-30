import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRemotePlugin } from '../remote-loader.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import { EVENT_CONTRACT_VERSION } from '../../runner/events.js';
import { withRuntime } from '../runtime-source.js';
import type { PluginHost } from '../host.js';

let scratch: string;
const open: PluginHost[] = [];

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-plugin-lifecycle-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

afterEach(() => {
  while (open.length) open.pop()!.dispose();
});

const LOOP = `
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

function writePlugin(name: string, body: string): string {
  const entry = join(scratch, `${name}.mjs`);
  writeFileSync(entry, `${LOOP}\nasync function onMessage(msg) {\n${body}\n}\n`);
  return entry;
}

function writeHelperPlugin(name: string, source: string): string {
  const entry = join(scratch, `${name}.mjs`);
  writeFileSync(entry, withRuntime(source));
  return entry;
}

function manifest(componentType: string, capabilities: string[] = []) {
  return {
    name: 'lifecycle-plugin',
    version: '1.0.0',
    capabilities,
    components: [{ componentType }],
  };
}

function hostFor(
  entry: string,
  manifestData: unknown,
  options: { timeout?: number; capabilities?: string[] } = {},
): PluginHost {
  const { host } = loadRemotePlugin(manifestData, entry, {
    timeout: options.timeout ?? 5_000,
    capabilities: (options.capabilities ?? []) as never,
  });
  open.push(host);
  return host;
}

function execute(
  host: PluginHost,
  componentType: string,
  input: Record<string, unknown> = {},
  onPartial?: (partial: unknown) => void,
): Promise<unknown> {
  return host.call(
    'execute',
    { componentType, node: { name: 'p' }, input, workspace: scratch },
    { onPartial },
  );
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('the version handshake', () => {
  it('greets the plugin before it asks it for anything', async () => {
    const entry = writePlugin(
      'greeted',
      `globalThis.__seen ??= [];
       globalThis.__seen.push(msg.method);
       if (msg.method === 'init') {
         globalThis.__greeting = msg.params;
         send({ id: msg.id, result: { protocol: ${PROTOCOL_VERSION} } });
         return;
       }
       send({ id: msg.id, result: { output: { seen: globalThis.__seen.slice(),
                                              greeting: globalThis.__greeting } } });`,
    );

    const host = hostFor(entry, manifest('GreetNode', ['runTool']), {
      capabilities: ['runTool'],
    });
    const result = (await execute(host, 'GreetNode')) as {
      output: { seen: string[]; greeting: Record<string, unknown> };
    };

    expect(result.output.seen).toEqual(['init', 'execute']);
    expect(result.output.greeting).toEqual({
      protocol: PROTOCOL_VERSION,
      events: EVENT_CONTRACT_VERSION,
      capabilities: ['runTool'],
    });
  });

  it('tells the plugin what it was granted, not what heddle can do', async () => {
    const entry = writePlugin(
      'ungranted',
      `if (msg.method === 'init') {
         globalThis.__greeting = msg.params;
         send({ id: msg.id, result: { protocol: ${PROTOCOL_VERSION} } });
         return;
       }
       send({ id: msg.id, result: { output: { greeting: globalThis.__greeting } } });`,
    );

    const host = hostFor(entry, manifest('UngrantedNode'), {
      capabilities: ['runTool'],
    });
    const result = (await execute(host, 'UngrantedNode')) as {
      output: { greeting: { capabilities: string[] } };
    };

    expect(result.output.greeting.capabilities).toEqual([]);
  });

  it('fails the call when the plugin speaks a different version', async () => {
    const entry = writePlugin(
      'future',
      `if (msg.method === 'init') { send({ id: msg.id, result: { protocol: 99 } }); return; }
       send({ id: msg.id, result: { output: { fine: true } } });`,
    );

    const host = hostFor(entry, manifest('FutureNode'));

    await expect(execute(host, 'FutureNode')).rejects.toThrow(
      /"lifecycle-plugin" speaks plugin protocol version 99.*speaks 1/s,
    );
  });

  it('refuses later calls once the versions are known not to match', async () => {
    const entry = writePlugin(
      'future-again',
      `if (msg.method === 'init') { send({ id: msg.id, result: { protocol: 7 } }); return; }
       send({ id: msg.id, result: { output: {} } });`,
    );

    const host = hostFor(entry, manifest('FutureAgainNode'));
    await expect(execute(host, 'FutureAgainNode')).rejects.toThrow(/version 7/);
    await expect(execute(host, 'FutureAgainNode')).rejects.toThrow(/version 7/);
  });

  it('runs a plugin that refuses the handshake', async () => {
    const entry = writePlugin(
      'legacy-error',
      `if (msg.method === 'init') {
         send({ id: msg.id, error: { message: 'unknown method: init' } });
         return;
       }
       send({ id: msg.id, result: { output: { ran: true } } });`,
    );

    const host = hostFor(entry, manifest('LegacyErrorNode'));
    await expect(execute(host, 'LegacyErrorNode')).resolves.toEqual({
      output: { ran: true },
    });
  });

  it('runs a plugin that ignores the handshake entirely', async () => {
    const entry = writePlugin(
      'legacy-silent',
      `if (msg.method === 'init') return;
       send({ id: msg.id, result: { output: { ran: true } } });`,
    );

    const host = hostFor(entry, manifest('LegacySilentNode'));
    await expect(execute(host, 'LegacySilentNode')).resolves.toEqual({
      output: { ran: true },
    });
  });

  it('runs a plugin whose handshake answer says nothing about a version', async () => {
    const entry = writePlugin(
      'shrugging',
      `send({ id: msg.id, result: { output: { ran: true } } });`,
    );

    const host = hostFor(entry, manifest('ShruggingNode'));
    await expect(execute(host, 'ShruggingNode')).resolves.toEqual({
      output: { ran: true },
    });
  });
});

describe('partials', () => {
  it('delivers each partial and still settles on the result', async () => {
    const entry = writePlugin(
      'streamer',
      `if (msg.method !== 'execute') return;
       send({ id: msg.id, partial: { token: 'he' } });
       send({ id: msg.id, partial: { token: 'llo' } });
       send({ id: msg.id, result: { output: { text: 'hello' } } });`,
    );

    const host = hostFor(entry, manifest('StreamNode'));
    const partials: unknown[] = [];
    const result = await execute(host, 'StreamNode', {}, (p) => partials.push(p));

    expect(partials).toEqual([{ token: 'he' }, { token: 'llo' }]);
    expect(result).toEqual({ output: { text: 'hello' } });
  });

  it('does not settle the call', async () => {
    const entry = writePlugin(
      'partial-only',
      `if (msg.method !== 'execute') return;
       send({ id: msg.id, partial: { token: 'a' } });`,
    );

    const host = hostFor(entry, manifest('PartialOnlyNode'), { timeout: 300 });
    await expect(execute(host, 'PartialOnlyNode')).rejects.toThrow(
      /did not answer execute within 300ms/,
    );
  });

  it('keeps a call alive for longer than its timeout while partials arrive', async () => {
    const entry = writePlugin(
      'slow-streamer',
      `if (msg.method !== 'execute') return;
       for (let i = 0; i < 9; i++) {
         await new Promise((r) => setTimeout(r, 100));
         send({ id: msg.id, partial: { i } });
       }
       send({ id: msg.id, result: { output: { finished: true } } });`,
    );

    const host = hostFor(entry, manifest('SlowStreamNode'), { timeout: 300 });
    const partials: unknown[] = [];
    const started = Date.now();
    const result = await execute(host, 'SlowStreamNode', {}, (p) => partials.push(p));

    expect(result).toEqual({ output: { finished: true } });
    expect(partials).toHaveLength(9);
    expect(Date.now() - started).toBeGreaterThan(300);
  });

  it('ignores a partial for a call nobody is waiting on', async () => {
    const entry = writePlugin(
      'stray',
      `if (msg.method !== 'execute') return;
       send({ id: 4242, partial: { orphan: true } });
       send({ id: msg.id, result: { output: { ok: true } } });`,
    );

    const host = hostFor(entry, manifest('StrayNode'));
    const partials: unknown[] = [];
    const result = await execute(host, 'StrayNode', {}, (p) => partials.push(p));

    expect(partials).toEqual([]);
    expect(result).toEqual({ output: { ok: true } });
  });

  it('fails the call when its own consumer cannot take a partial', async () => {
    const entry = writePlugin(
      'thrower',
      `if (msg.method !== 'execute') return;
       send({ id: msg.id, partial: { token: 'a' } });
       send({ id: msg.id, result: { output: {} } });`,
    );

    const host = hostFor(entry, manifest('ThrowerNode'));
    await expect(
      execute(host, 'ThrowerNode', {}, () => {
        throw new Error('consumer gave up');
      }),
    ).rejects.toThrow(/consumer gave up/);
  });
});

function writeHangingPlugin(name: string, cancels: boolean): string {
  return writePlugin(
    name,
    `if (msg.method === 'init') return;
     if (msg.method === 'cancel') {
       ${cancels ? `send({ id: msg.id, result: {} });` : `/* ignored */`}
       return;
     }
     if (msg.params.input.hang) return;
     send({ id: msg.id, result: { output: { alive: true } } });`,
  );
}

describe('cancelling a call heddle has given up on', () => {
  it('rejects the call whether or not the plugin ever answers the cancel', async () => {
    const host = hostFor(writeHangingPlugin('deaf', false), manifest('DeafNode'), {
      timeout: 200,
    });

    const started = Date.now();
    await expect(execute(host, 'DeafNode', { hang: true })).rejects.toThrow(
      /did not answer execute within 200ms/,
    );
    expect(Date.now() - started).toBeLessThan(450);
  });

  it('keeps the process for the next call when the plugin acknowledges', async () => {
    const host = hostFor(writeHangingPlugin('polite', true), manifest('PoliteNode'), {
      timeout: 200,
    });

    await expect(execute(host, 'PoliteNode', { hang: true })).rejects.toThrow(
      /did not answer execute/,
    );
    await wait(800);

    await expect(execute(host, 'PoliteNode')).resolves.toEqual({
      output: { alive: true },
    });
  });

  it('kills a plugin that will not acknowledge', async () => {
    const host = hostFor(writeHangingPlugin('stubborn', false), manifest('StubbornNode'), {
      timeout: 200,
    });

    await expect(execute(host, 'StubbornNode', { hang: true })).rejects.toThrow(
      /did not answer execute/,
    );
    await wait(800);

    await expect(execute(host, 'StubbornNode')).rejects.toThrow(/SIGKILL/);
  });
});

describe('stopping a plugin process', () => {
  it('asks before it kills', async () => {
    const marker = join(scratch, 'said-goodbye');
    const entry = writePlugin(
      'polite-exit',
      `if (msg.method === 'shutdown') {
         const { writeFileSync } = await import('node:fs');
         writeFileSync(${JSON.stringify(marker)}, 'bye');
         process.exit(0);
       }
       if (msg.method === 'init') return;
       send({ id: msg.id, result: { output: {} } });`,
    );

    const host = hostFor(entry, manifest('PoliteExitNode'));
    await execute(host, 'PoliteExitNode');

    host.dispose();
    await wait(500);

    expect(existsSync(marker)).toBe(true);
  });

  it('kills a plugin that ignores both the verb and its closed stdin', async () => {
    const entry = writePlugin(
      'immortal',
      `if (msg.method === 'init' || msg.method === 'shutdown') return;
       setInterval(() => {}, 1000);
       send({ id: msg.id, result: { output: { pid: process.pid } } });`,
    );

    const host = hostFor(entry, manifest('ImmortalNode'));
    const result = (await execute(host, 'ImmortalNode')) as { output: { pid: number } };
    const pid = result.output.pid;
    expect(alive(pid)).toBe(true);

    host.dispose();
    await until(() => !alive(pid), 3_000);

    expect(alive(pid)).toBe(false);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean, deadline: number): Promise<void> {
  const stop = Date.now() + deadline;
  while (!condition() && Date.now() < stop) await wait(50);
}

function speakTo(
  entry: string,
  frames: unknown[],
  want: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
    const replies: Array<Record<string, unknown>> = [];
    let stderr = '';

    const giveUp = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(
        new Error(
          `plugin sent ${replies.length} of ${want} replies${stderr ? `: ${stderr}` : ''}`,
        ),
      );
    }, 4_000);

    let buf = '';
    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        replies.push(JSON.parse(line) as Record<string, unknown>);
        if (replies.length >= want) {
          clearTimeout(giveUp);
          proc.kill('SIGKILL');
          resolve(replies);
        }
      }
    });

    proc.stderr.setEncoding('utf-8');
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    proc.on('error', reject);

    for (const frame of frames) proc.stdin.write(`${JSON.stringify(frame)}\n`);
  });
}

describe('the inlined runtime helper', () => {
  it('answers the handshake with the version it was generated from', async () => {
    const entry = writeHelperPlugin(
      'helper-init',
      `serve({ Noop: { execute: () => ({ output: {} }) } });`,
    );

    const [reply] = await speakTo(entry, [{ id: 1, method: 'init', params: {} }], 1);

    expect(reply).toEqual({ id: 1, result: { protocol: PROTOCOL_VERSION } });
  });

  it('acknowledges a cancel only after dropping the call it names', async () => {
    const entry = writeHelperPlugin(
      'helper-cancel',
      `serve({
         Hang: {
           execute: (input, ctx) =>
             new Promise((resolve) => {
               ctx.signal.addEventListener('abort', () => resolve({ output: { late: true } }));
             }),
         },
       });`,
    );

    const replies = await speakTo(
      entry,
      [
        { id: 1, method: 'execute', params: { componentType: 'Hang', input: {} } },
        { id: 2, method: 'cancel', params: { call: 1 } },
      ],
      1,
    );

    expect(replies).toEqual([{ id: 2, result: {} }]);
  });

  it('runs a plugin shutdown hook before the process ends', async () => {
    const marker = join(scratch, 'helper-said-goodbye');
    const entry = writeHelperPlugin(
      'helper-shutdown',
      `import { writeFileSync } from 'node:fs';
       serve(
         { Noop: { execute: () => ({ output: {} }) } },
         { shutdown: () => writeFileSync(${JSON.stringify(marker)}, 'bye') },
       );`,
    );

    const host = hostFor(entry, manifest('Noop'));
    await execute(host, 'Noop');

    host.dispose();
    await until(() => existsSync(marker), 2_000);

    expect(existsSync(marker)).toBe(true);
  });
});

describe('a plugin that writes JSON which is not a frame', () => {
  const cases: Array<[string, string]> = [
    ['null', 'null'],
    ['a bare number', '42'],
    ['an array', '[1,2,3]'],
    ['a string', '"hello"'],
  ];

  for (const [label, literal] of cases) {
    it(`fails the call rather than the process, for ${label}`, async () => {
      const entry = writePlugin(
        `garbage-${literal.replace(/\W/g, '')}`,
        `if (msg.method !== 'execute') return;
         process.stdout.write('${literal.replace(/'/g, "\\'")}' + '\\n');`,
      );

      const host = hostFor(entry, manifest('GarbageNode'), { timeout: 2000 });
      await expect(execute(host, 'GarbageNode')).rejects.toThrow(
        /not a protocol frame|is not JSON/,
      );
      expect(process.exitCode ?? 0).toBe(0);
    });
  }
});
