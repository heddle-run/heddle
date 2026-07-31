/**
 * The policies `examples/policies/` ships, run as an operator would run them.
 *
 * Two things this pins that nothing else did. The example itself — a README that
 * quotes output nobody re-runs is a README that drifts — and the shape it is the
 * first consumer of: more than one middleware in one chain, over one plugin
 * process, deciding at more than one seam. Every other middleware test loads a
 * single policy at a single seam.
 *
 * It also exercises the on-disk out-of-process path end to end. A submitted
 * plugin gets the runtime prepended to its source; this one is a file heddle did
 * not write, and gets the same runtime on the command line instead. Before that
 * landed, every `serve(...)` in the documentation was true only of plugins sent
 * to a server.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlugins } from '../loader.js';
import { MiddlewareChain } from '../middleware.js';
import type { PluginRegistry } from '../registry.js';
import type { Event } from '../../runner/events.js';

const repoRoot = join(fileURLToPath(import.meta.url), '../../../../../..');
const manifest = join(repoRoot, 'examples/policies/policies.json');

const open: PluginRegistry[] = [];

afterAll(() => {
  while (open.length > 0) open.pop()!.dispose();
});

async function installed(
  config: Record<string, Record<string, unknown>>,
): Promise<MiddlewareChain> {
  const registry = await loadPlugins([manifest], { timeout: 10_000 });
  open.push(registry);

  return MiddlewareChain.build(registry, {}, config);
}

const failed = (message: string) => ({
  ok: false as const,
  error: { name: 'ToolError', message },
});

const nodeError = (
  chain: MiddlewareChain,
  message: string,
  attempt: number,
  maxAttempts = 3,
  events: Event[] = [],
) =>
  chain.consult(
    'nodeError',
    {
      subject: { nodeName: 'lookup', nodeType: 'ToolNode' },
      outcome: failed(message),
      attempt,
      maxAttempts,
      allowRetry: attempt < maxAttempts,
    },
    undefined,
    (event) => events.push(event),
  );

describe('the manifest an operator installs', () => {
  it('declares every policy the README documents', async () => {
    const registry = await loadPlugins([manifest], { timeout: 10_000 });
    open.push(registry);

    expect(registry.middlewareDefs().map(({ def }) => def.componentType)).toEqual([
      'RetryPolicy',
      'ApprovalGate',
      'NodeAudit',
      'RateLimit',
    ]);
    // The stub model is a provider, not a policy, and a spec has to name it.
    expect(registry.kindOf('StubModelConfig')).toBe('provider');
  });

  it('refuses a setting its schema does not have', async () => {
    await expect(
      installed({ RetryPolicy: { backofMs: 50 } }),
    ).rejects.toThrow(/backofMs/);
  });
});

describe('RetryPolicy, at nodeError', () => {
  it('retries an error it was told is transient, backing off as it goes', async () => {
    const chain = await installed({ RetryPolicy: { backoffMs: 50 } });

    expect(await nodeError(chain, 'upstream timed out', 1)).toMatchObject({
      action: 'retry',
      delayMs: 50,
      by: 'RetryPolicy',
    });
    expect(await nodeError(chain, 'upstream timed out', 2)).toMatchObject({
      action: 'retry',
      delayMs: 100,
    });
  });

  it('lets an error no retry would fix stand, on the first attempt', async () => {
    const chain = await installed({ RetryPolicy: {} });

    expect(await nodeError(chain, 'no such record', 1)).toEqual({ action: 'pass' });
  });

  it('substitutes once the attempts heddle allows are spent', async () => {
    const chain = await installed({
      RetryPolicy: { substitute: { answer: 'unavailable' } },
    });

    expect(await nodeError(chain, 'upstream timed out', 3)).toMatchObject({
      action: 'replace',
      value: { answer: 'unavailable' },
      by: 'RetryPolicy',
    });
  });

  it('reports the substitution as an event, so it is not silent', async () => {
    const events: Event[] = [];
    const chain = await installed({
      RetryPolicy: { substitute: { answer: 'unavailable' } },
    });

    await nodeError(chain, 'no such record', 1, 3, events);

    expect(events.find((e) => e.type === 'plugin:RetryPolicy:substituted')).toMatchObject({
      data: { node: 'lookup', cause: 'no such record' },
    });
  });
});

describe('ApprovalGate, at toolCall', () => {
  const guard = { ApprovalGate: { guard: { shell: ['rm -rf', 'sudo'] } } };

  const before = (chain: MiddlewareChain, args: Record<string, unknown>) =>
    chain.consultBefore(
      'toolCall',
      { nodeName: 'agent', nodeType: 'AgentNode', toolName: 'shell', toolCallId: 'c1' },
      args,
      undefined,
      undefined,
    );

  it('refuses a call carrying a pattern the operator forbade, and says which', async () => {
    const chain = await installed(guard);

    expect(await before(chain, { cmd: 'rm -rf /var/data' })).toMatchObject({
      action: 'reject',
      by: 'ApprovalGate',
    });
    expect(
      ((await before(chain, { cmd: 'sudo reboot' })) as { reason: string }).reason,
    ).toContain('sudo');
  });

  it('lets an ordinary call through', async () => {
    const chain = await installed(guard);

    expect(await before(chain, { cmd: 'ls -la' })).toEqual({ action: 'proceed' });
  });

  it('guards nothing it was not told to guard', async () => {
    const chain = await installed({ ApprovalGate: {} });

    expect(await before(chain, { cmd: 'rm -rf /' })).toEqual({ action: 'proceed' });
  });

  it('replaces a result too large to be worth what the model pays for it', async () => {
    const chain = await installed({ ApprovalGate: { maxResultBytes: 20 } });
    const oversized = { stdout: 'x'.repeat(500) };

    const verdict = await chain.consult(
      'toolCall',
      {
        subject: { nodeName: 'agent', toolName: 'shell', toolCallId: 'c1' },
        outcome: { ok: true, value: oversized },
        attempt: 1,
        maxAttempts: 1,
        allowRetry: false,
      },
      undefined,
      undefined,
    );

    // The size it *was*, so a reader of the transcript knows what was dropped.
    expect(verdict).toMatchObject({
      action: 'replace',
      value: { omitted: true, bytes: JSON.stringify(oversized).length },
    });
  });

  it('leaves a failed call to somebody else, having nothing to truncate', async () => {
    const chain = await installed({ ApprovalGate: { maxResultBytes: 20 } });

    const verdict = await chain.consult(
      'toolCall',
      {
        subject: { nodeName: 'agent', toolName: 'shell', toolCallId: 'c1' },
        outcome: failed('the tool exited 1'),
        attempt: 1,
        maxAttempts: 1,
        allowRetry: false,
      },
      undefined,
      undefined,
    );

    expect(verdict).toEqual({ action: 'pass' });
  });
});

describe('NodeAudit, at node', () => {
  const before = (chain: MiddlewareChain, nodeType: string, events: Event[] = []) =>
    chain.consultBefore(
      'node',
      { nodeName: 'lookup', nodeType },
      { query: 'anything' },
      undefined,
      (event) => events.push(event),
    );

  it('watches a node without touching it', async () => {
    const events: Event[] = [];
    const chain = await installed({ NodeAudit: {} });

    expect(await before(chain, 'ToolNode')).toEqual({ action: 'proceed' });

    const verdict = await chain.consult(
      'node',
      {
        subject: { nodeName: 'lookup', nodeType: 'ToolNode' },
        outcome: { ok: true, value: { answer: 'found' } },
        attempt: 1,
        maxAttempts: 3,
        allowRetry: false,
      },
      undefined,
      (event) => events.push(event),
    );

    expect(verdict).toEqual({ action: 'pass' });
    expect(events.find((e) => e.type === 'plugin:NodeAudit:node')).toMatchObject({
      data: { node: 'lookup', type: 'ToolNode', ok: true, attempt: 1 },
    });
  });

  it('records a failure too, and still lets it stand', async () => {
    const events: Event[] = [];
    const chain = await installed({ NodeAudit: {} });

    const verdict = await chain.consult(
      'node',
      {
        subject: { nodeName: 'lookup', nodeType: 'ToolNode' },
        outcome: failed('upstream timed out'),
        attempt: 3,
        maxAttempts: 3,
        allowRetry: false,
      },
      undefined,
      (event) => events.push(event),
    );

    expect(verdict).toEqual({ action: 'pass' });
    expect(events.find((e) => e.type === 'plugin:NodeAudit:node')).toMatchObject({
      data: { ok: false, attempt: 3 },
    });
  });

  it('answers for a node type the operator asked it to skip', async () => {
    const events: Event[] = [];
    const chain = await installed({
      NodeAudit: { dryRun: ['ToolNode'], stub: { answer: 'not really run' } },
    });

    expect(await before(chain, 'ToolNode', events)).toMatchObject({
      action: 'replace',
      value: { answer: 'not really run' },
      by: 'NodeAudit',
    });
    expect(events.find((e) => e.type === 'plugin:NodeAudit:skipped')).toBeDefined();
  });

  it('leaves the node types it was not asked about alone', async () => {
    const chain = await installed({ NodeAudit: { dryRun: ['ToolNode'] } });

    expect(await before(chain, 'AgentNode')).toEqual({ action: 'proceed' });
  });
});

describe('RateLimit, at modelCall', () => {
  const ask = (chain: MiddlewareChain) =>
    chain.consultBefore(
      'modelCall',
      { nodeName: 'agent', nodeType: 'AgentNode' },
      { model: 'gpt-4o', messages: [] },
      undefined,
      undefined,
    );

  it('counts calls across the process, not across a run', async () => {
    // The distinction the example is written to teach: one process serves every
    // run on a server, so this is one budget and there is no run to key it by.
    const chain = await installed({ RateLimit: { callsPerMinute: 2 } });

    expect(await ask(chain)).toEqual({ action: 'proceed' });
    expect(await ask(chain)).toEqual({ action: 'proceed' });
    expect(await ask(chain)).toMatchObject({ action: 'reject', by: 'RateLimit' });
  });

  it('does nothing at all when the operator set no rate', async () => {
    const chain = await installed({ RateLimit: {} });

    for (let i = 0; i < 5; i++) {
      expect(await ask(chain)).toEqual({ action: 'proceed' });
    }
  });

  it('re-issues a model call that failed for a reason re-issuing would fix', async () => {
    const chain = await installed({ RateLimit: { backoffMs: 10 } });

    const verdict = await chain.consult(
      'modelCall',
      {
        subject: { nodeName: 'agent', nodeType: 'AgentNode' },
        outcome: failed('429 Too Many Requests'),
        attempt: 1,
        maxAttempts: 3,
        allowRetry: true,
      },
      undefined,
      undefined,
    );

    expect(verdict).toMatchObject({ action: 'retry', delayMs: 10, by: 'RateLimit' });
  });
});

describe('all three in one chain', () => {
  it('leaves each seam to the policy that subscribed to it', async () => {
    const chain = await installed({
      RetryPolicy: { retryOn: ['in the last minute'], backoffMs: 10 },
      ApprovalGate: { guard: { shell: ['rm -rf'] } },
      RateLimit: { callsPerMinute: 1 },
    });

    // Three middleware are loaded and every one of these is decided by exactly
    // one of them. A chain is consulted in order and the first non-`pass`
    // verdict wins, so a policy that answers a seam it did not subscribe to
    // would show up here as the wrong `by`.
    expect(
      await chain.consultBefore(
        'modelCall',
        { nodeName: 'agent' },
        { model: 'gpt-4o', messages: [] },
        undefined,
        undefined,
      ),
    ).toEqual({ action: 'proceed' });

    expect(
      await chain.consultBefore(
        'modelCall',
        { nodeName: 'agent' },
        { model: 'gpt-4o', messages: [] },
        undefined,
        undefined,
      ),
    ).toMatchObject({ action: 'reject', by: 'RateLimit' });

    expect(
      await chain.consultBefore(
        'toolCall',
        { nodeName: 'agent', toolName: 'shell', toolCallId: 'c1' },
        { cmd: 'rm -rf /' },
        undefined,
        undefined,
      ),
    ).toMatchObject({ action: 'reject', by: 'ApprovalGate' });

    // And the composition the README shows: a rate limit refuses the model call,
    // which fails the node, which is what nodeError is asked about.
    expect(
      await nodeError(
        chain,
        '"RateLimit" refused the model call for "agent": this host has made 1 ' +
          'model calls in the last minute and allows 1',
        1,
      ),
    ).toMatchObject({ action: 'retry', by: 'RetryPolicy' });
  });
});
