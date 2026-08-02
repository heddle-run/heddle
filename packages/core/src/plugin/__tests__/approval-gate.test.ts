/**
 * The approval gate `examples/approval-gate/` ships, run out of process.
 *
 * The suspension tests next door build their middleware in-process, which
 * proves the seam. This proves the *shipped example*: a manifest heddle did not
 * write, a `serve(...)` handler in another process, and a `suspend` verdict
 * that has to survive the JSON boundary with its `ask` intact — because that
 * `ask` is the only thing the person on the other end will see.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '../loader.js';
import { MiddlewareChain } from '../middleware.js';
import type { PluginRegistry } from '../registry.js';

const repoRoot = join(fileURLToPath(import.meta.url), '../../../../../..');
const manifest = join(repoRoot, 'examples/approval-gate/gate.json');

const open: PluginRegistry[] = [];

afterAll(() => {
  while (open.length > 0) open.pop()!.dispose();
});

async function gate(tools: string[]): Promise<MiddlewareChain> {
  const registry = await loadPlugins([manifest], { timeout: 10_000 });
  open.push(registry);

  return MiddlewareChain.build(registry, {}, { ApprovalGate: { tools } });
}

function consult(
  chain: MiddlewareChain,
  toolName: string,
  input: Record<string, unknown> = { amount: 100 },
) {
  return chain.consultBefore(
    'toolCall',
    { toolName, toolCallId: 'c1' },
    input,
    undefined as never,
    undefined,
  );
}

describe('the shipped approval gate', () => {
  it('lets through a tool it was not asked to guard', async () => {
    const chain = await gate(['refund']);

    expect(await consult(chain, 'lookup')).toEqual({ action: 'proceed' });
  }, 30_000);

  it('suspends the one it was, carrying the question across the boundary', async () => {
    const chain = await gate(['refund']);
    const verdict = await consult(chain, 'refund', { order: '991' });

    expect(verdict).toMatchObject({
      action: 'suspend',
      by: 'ApprovalGate',
      ask: {
        question: 'Approve refund?',
        arguments: { order: '991' },
        reply: { approved: 'true or false' },
      },
    });
  }, 30_000);

  it('guards nothing when the operator configured nothing', async () => {
    const chain = await gate([]);

    expect(await consult(chain, 'refund')).toEqual({ action: 'proceed' });
  }, 30_000);
});
