import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadRemotePlugin } from '../remote-loader.js';
import { PROTOCOL_VERSION } from '../protocol.js';
import { EVENT_CONTRACT_VERSION } from '../../runner/events.js';
import type { PluginHost } from '../host.js';
import { manifest as baseManifest, useDisposal, useScratch } from './helpers/remote-plugin.js';

const scratch = useScratch('heddle-plugin-lifecycle-');
const open = useDisposal<PluginHost>();

// The plugin name is asserted in the handshake failures below.
const manifest = (
  componentType: string,
  capabilities: string[] = [],
): Record<string, unknown> =>
  baseManifest(componentType, {}, capabilities, 'lifecycle-plugin');

function hostFor(
  entry: string,
  manifestData: unknown,
  options: { timeout?: number; capabilities?: string[] } = {},
): PluginHost {
  const { host } = loadRemotePlugin(manifestData, entry, {
    timeout: options.timeout ?? 5_000,
    capabilities: (options.capabilities ?? []) as never,
  });
  open.track(host);
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
    { componentType, node: { name: 'p' }, input, workspace: scratch.path },
    { onPartial },
  );
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('the version handshake', () => {
  it('greets the plugin before it asks it for anything', async () => {
    const entry = scratch.writeLoopPlugin(
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
    const entry = scratch.writeLoopPlugin(
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
    const entry = scratch.writeLoopPlugin(
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
    const entry = scratch.writeLoopPlugin(
      'future-again',
      `if (msg.method === 'init') { send({ id: msg.id, result: { protocol: 7 } }); return; }
       send({ id: msg.id, result: { output: {} } });`,
    );

    const host = hostFor(entry, manifest('FutureAgainNode'));
    await expect(execute(host, 'FutureAgainNode')).rejects.toThrow(/version 7/);
    await expect(execute(host, 'FutureAgainNode')).rejects.toThrow(/version 7/);
  });

  it('runs a plugin that refuses the handshake', async () => {
    const entry = scratch.writeLoopPlugin(
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
    const entry = scratch.writeLoopPlugin(
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
    const entry = scratch.writeLoopPlugin(
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
    const entry = scratch.writeLoopPlugin(
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

  /**
   * Asked of the call directly rather than through a timeout. The earlier
   * version gave the host a 300ms budget and waited for the rejection, which
   * proved the call was still open only by outliving a window that also had to
   * cover starting the process — so on a machine slow enough it would have
   * timed out before the partial ever arrived, and passed without a partial
   * having failed to settle anything.
   *
   * A partial is delivered inside `receive`, and a host that settled on one
   * would resolve the call in that same turn. So once the partial is in hand
   * and the microtask queue has drained, which awaiting anything at all
   * guarantees, the call is either settled or it is not, and no duration comes
   * into it. The budget goes back to its default, where nothing is waiting on
   * it.
   */
  it('does not settle the call', async () => {
    const entry = scratch.writeLoopPlugin(
      'partial-only',
      `if (msg.method !== 'execute') return;
       send({ id: msg.id, partial: { token: 'a' } });`,
    );

    const host = hostFor(entry, manifest('PartialOnlyNode'));
    const partials: unknown[] = [];
    let settled = false;
    void execute(host, 'PartialOnlyNode', {}, (p) => partials.push(p)).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await until(() => partials.length > 0, 3_000);

    expect(partials).toEqual([{ token: 'a' }]);
    expect(settled).toBe(false);
  });

  /**
   * The twin of the reporting test in `reporting.test.ts`, and robust for the
   * same reasons: a partial restarts the same clock a report does, so a call
   * that keeps streaming outlives the timeout it was given.
   *
   * The budget covers starting the plugin, which the clock is already running
   * for — node reaches its first line in about 40ms here and about 90ms on a
   * machine with three times more runnable processes than cores, against a
   * budget of 1000ms. Each later window covers one send, at forty to one.
   *
   * The loop ends when the plugin's own clock says it has outlived the budget,
   * rather than after a fixed nine sleeps of 100ms against 300ms, which was a
   * margin narrow enough for a loaded machine to close.
   */
  it('keeps a call alive for longer than its timeout while partials arrive', async () => {
    const budget = 1_000;
    const entry = scratch.writeLoopPlugin(
      'slow-streamer',
      `if (msg.method !== 'execute') return;
       const stop = Date.now() + ${budget * 1.2};
       let sent = 0;
       while (Date.now() < stop) {
         await new Promise((r) => setTimeout(r, 25));
         send({ id: msg.id, partial: { i: sent++ } });
       }
       send({ id: msg.id, result: { output: { finished: true, sent } } });`,
    );

    const host = hostFor(entry, manifest('SlowStreamNode'), { timeout: budget });
    const partials: unknown[] = [];
    const started = Date.now();
    const result = await execute(host, 'SlowStreamNode', {}, (p) => partials.push(p));

    expect(partials.length).toBeGreaterThan(1);
    expect(result).toEqual({ output: { finished: true, sent: partials.length } });
    expect(Date.now() - started).toBeGreaterThan(budget);
  });

  it('ignores a partial for a call nobody is waiting on', async () => {
    const entry = scratch.writeLoopPlugin(
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
    const entry = scratch.writeLoopPlugin(
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

/**
 * A plugin that never answers what it was asked, having first said who it is.
 *
 * The pid rides in on a partial rather than on a call of its own, because every
 * call here is made against a 200ms budget and a call that has to *succeed*
 * inside one is a call racing node's startup: about 40ms idle and about 90ms on
 * a loaded machine, against a budget the whole point of which is to be short. A
 * partial costs no extra call, and it doubles as evidence that the plugin
 * received the frame at all — a timeout that happened before it did would say
 * nothing about a plugin refusing to answer.
 *
 * Restarting the clock is exactly what a partial does, so the budget then runs
 * from the moment the plugin went quiet, which is what these tests are about.
 */
function writeHangingPlugin(name: string, cancels: boolean): string {
  return scratch.writeLoopPlugin(
    name,
    `if (msg.method === 'init') return;
     if (msg.method === 'cancel') {
       ${cancels ? `send({ id: msg.id, result: {} });` : `/* ignored */`}
       return;
     }
     if (msg.params.input.hang) {
       send({ id: msg.id, partial: { pid: process.pid } });
       return;
     }
     send({ id: msg.id, result: { output: { alive: true } } });`,
  );
}

/**
 * How long the host waits for a cancel to be acknowledged before it kills, from
 * `CANCEL_GRACE` in host.ts. Mirrored rather than imported because it is not
 * exported, and every wait below is a multiple of it: what these tests are
 * about is what happens on either side of that window.
 */
const CANCEL_GRACE = 500;

/** Make a call the plugin will not answer, and name the process it hung in. */
async function pidOfAbandonedCall(
  host: PluginHost,
  componentType: string,
): Promise<number> {
  const pids: number[] = [];
  await expect(
    execute(host, componentType, { hang: true }, (p) =>
      pids.push((p as { pid: number }).pid),
    ),
  ).rejects.toThrow(/did not answer execute within 200ms/);

  expect(pids).toHaveLength(1);
  return pids[0];
}

describe('cancelling a call heddle has given up on', () => {
  /**
   * The caller is freed at the timeout, not when the plugin gets round to
   * agreeing. A deaf plugin never agrees, so the two are separated by the whole
   * cancel grace.
   *
   * Stated as ordering rather than as a duration. The earlier version timed the
   * whole call and asked for under 450ms, which is a 200ms budget plus 250ms of
   * slack to start node in and be rejected in — so what the slack was really
   * being spent on was startup, and a loaded machine spent more than there was.
   * Asking instead whether the plugin is still running when the rejection lands
   * says the same thing and cannot be affected by scheduling: had the caller
   * been made to wait on the cancel, the SIGKILL that ends that wait would
   * already have happened, and nothing but microtasks runs between the
   * rejection and the check.
   */
  it('rejects the call whether or not the plugin ever answers the cancel', async () => {
    const host = hostFor(writeHangingPlugin('deaf', false), manifest('DeafNode'), {
      timeout: 200,
    });

    const pid = await pidOfAbandonedCall(host, 'DeafNode');
    expect(alive(pid)).toBe(true);
  });

  it('keeps the process for the next call when the plugin acknowledges', async () => {
    const host = hostFor(writeHangingPlugin('polite', true), manifest('PoliteNode'), {
      timeout: 200,
    });

    const pid = await pidOfAbandonedCall(host, 'PoliteNode');
    // The one wait here that has to be a duration: nothing is expected to
    // happen, and the test is that nothing does. Three grace periods, because
    // an acknowledgement that failed to disarm the kill would be a kill landing
    // one grace period from now, and a wait that only just cleared it would let
    // a loaded machine sit the bug out.
    await wait(3 * CANCEL_GRACE);
    expect(alive(pid)).toBe(true);

    await expect(execute(host, 'PoliteNode')).resolves.toEqual({
      output: { alive: true },
    });
  });

  it('kills a plugin that will not acknowledge', async () => {
    const host = hostFor(writeHangingPlugin('stubborn', false), manifest('StubbornNode'), {
      timeout: 200,
    });

    const pid = await pidOfAbandonedCall(host, 'StubbornNode');
    // Polled to the death rather than slept past it. The kill is due one grace
    // period after the call was abandoned; waiting a fixed 800ms for it asked
    // that it be no more than 300ms late, and a deadline of six grace periods
    // that returns as soon as the process goes costs less on a machine where it
    // is punctual.
    await until(() => !alive(pid), 6 * CANCEL_GRACE);
    expect(alive(pid)).toBe(false);

    await expect(execute(host, 'StubbornNode')).rejects.toThrow(/SIGKILL/);
  });
});

describe('stopping a plugin process', () => {
  it('asks before it kills', async () => {
    const marker = join(scratch.path, 'said-goodbye');
    const entry = scratch.writeLoopPlugin(
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
    // Polled like the shutdown hook below, rather than slept at for a fixed
    // 500ms. Something is expected to happen here, so a wait is a guess about
    // how long another process takes to be scheduled, write a file and exit,
    // and a machine that takes longer than the guess fails a test about asking
    // before killing. Waiting for the file itself is the same test without the
    // guess, and it returns as soon as the plugin has said goodbye.
    await until(() => existsSync(marker), 3_000);

    expect(existsSync(marker)).toBe(true);
  });

  it('kills a plugin that ignores both the verb and its closed stdin', async () => {
    const entry = scratch.writeLoopPlugin(
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
    const entry = scratch.writeHelperPlugin(
      'helper-init',
      `serve({ Noop: { execute: () => ({ output: {} }) } });`,
    );

    const [reply] = await speakTo(entry, [{ id: 1, method: 'init', params: {} }], 1);

    expect(reply).toEqual({ id: 1, result: { protocol: PROTOCOL_VERSION } });
  });

  it('acknowledges a cancel only after dropping the call it names', async () => {
    const entry = scratch.writeHelperPlugin(
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
    const marker = join(scratch.path, 'helper-said-goodbye');
    const entry = scratch.writeHelperPlugin(
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
      const entry = scratch.writeLoopPlugin(
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
