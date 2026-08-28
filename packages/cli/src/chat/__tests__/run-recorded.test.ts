/**
 * The chat turn runner, across a suspension.
 *
 * The bug this covers: a session-backed chat ran with no checkpoint sink, so a
 * middleware that suspended for approval died with "nowhere to be written
 * down" even under --session. These tests drive `runRecorded` over a real file
 * store and a middleware that suspends once, and prove the turn now asks, then
 * resumes on the answer and finishes — the way the non-chat run already did.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compile,
  DEFAULT_RUNNER_OPTIONS,
  FileSessionStore,
  loadFlow,
  MiddlewareChain,
  PluginRegistry,
  type CompiledGraph,
  type Dependencies,
  type Provider,
  type ToolCall,
} from '@heddle-run/core';
import { runRecorded, type Ask } from '../ui.js';

let root: string;
let store: FileSessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'heddle-chat-'));
  store = new FileSessionStore({ root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Models the real approve→re-issue→run cycle.
 *
 * heddle's suspend answers the call: an approval comes back as the tool's
 * *result*, not as the tool running. So a model that wanted the command run
 * re-issues it after a `{approved:true}` — and the second time the gate lets
 * it through and the tool actually runs. That is the loop the coding agent's
 * CodexApprovals is built around, mirrored here so the tool genuinely runs.
 */
function providerAsking(calls: ToolCall[]): Provider {
  return {
    chatCompletion: async (_signal, request) => {
      const toolMessages = request.messages.filter((m) => m.role === 'tool');
      const last = toolMessages.at(-1);
      if (!last) {
        return { content: '', finish_reason: 'tool_calls', tool_calls: calls };
      }
      const content = String(last.content ?? '');
      if (content.includes('"approved":true')) {
        // The human said yes; re-issue so the approved command actually runs.
        return { content: '', finish_reason: 'tool_calls', tool_calls: calls };
      }
      return { content: 'all done', finish_reason: 'stop' };
    },
  };
}

/** A gate that suspends the first time it sees the tool, then lets it run. */
function gateOnce(tool: string): MiddlewareChain {
  let suspended = false;
  const def = {
    componentType: 'GateOnce',
    seams: { toolCall: ['before'] as const },
    createMiddleware: () => ({
      before: ({ subject }: { subject: { toolName: string } }) => {
        if (subject.toolName !== tool || suspended) {
          return { action: 'proceed' as const };
        }
        suspended = true;
        return {
          action: 'suspend' as const,
          ask: { question: `Approve ${tool}?`, tool },
        };
      },
    }),
  };
  return MiddlewareChain.build(
    PluginRegistry.fromPlugins([
      { name: 'gate', version: '1.0.0', middleware: [def] as never },
    ]),
    {},
  );
}

/** A one-agent flow whose agent has a single tool, written and parsed. */
function agentFlow(tool: string): ReturnType<typeof loadFlow> {
  const spec = {
    weave: 1,
    name: 'gated',
    inputs: { task: 'string' },
    tools: {
      [tool]: {
        description: 'the gated tool',
        outputs: { ran: 'string' },
      },
    },
    agent: {
      model: { provider: 'openai', model: 'gpt-4o' },
      prompt: 'do the thing: {{inputs.task}}',
      tools: [tool],
    },
  };
  const path = join(root, 'flow.json');
  writeFileSync(path, JSON.stringify(spec));
  return loadFlow(path);
}

function graphThatCalls(
  tool: string,
  chain: MiddlewareChain,
  ran: string[],
): CompiledGraph {
  const call: ToolCall = { id: 'c1', name: tool, arguments: '{}' };
  const deps: Dependencies = {
    middleware: chain,
    createProvider: () => providerAsking([call]),
    toolRegistry: {
      lookup: (name: string) => ({
        name,
        description: '',
        origin: 'test',
        impl: {
          kind: 'plugin' as const,
          plugin: 'test',
          call: async () => {
            ran.push(name);
            return { output: { ran: name }, stderr: '' };
          },
        },
      }),
      all: () => [],
    },
  };
  return compile(agentFlow(tool), deps);
}

describe('runRecorded across a suspension', () => {
  it('asks the human, then resumes and finishes on the answer', async () => {
    const ran: string[] = [];
    const graph = graphThatCalls('shell', gateOnce('shell'), ran);
    const session = { store, id: 'chat-suspend-1', turns: [] };

    const asked: Ask[] = [];
    const approve = async (ask: Ask) => {
      asked.push(ask);
      return { approved: true };
    };

    const answer = await runRecorded(
      graph,
      { ...DEFAULT_RUNNER_OPTIONS },
      session,
      'flow.json',
      { task: 'do it' },
      approve,
    );

    // It stopped to ask exactly once, about the gated tool.
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ tool: 'shell' });
    // The answer let the run continue: the tool ran, and the turn finished.
    expect(ran).toEqual(['shell']);
    expect(answer).toBe('all done');
    // The turn closed cleanly: its checkpoint is gone, nothing left to resume.
    expect(await store.readCheckpoint(session.id)).toBeUndefined();
  });

  it('records the finished turn in the conversation', async () => {
    const ran: string[] = [];
    const graph = graphThatCalls('shell', gateOnce('shell'), ran);
    const session = { store, id: 'chat-suspend-2', turns: [] };

    await runRecorded(
      graph,
      { ...DEFAULT_RUNNER_OPTIONS },
      session,
      'flow.json',
      { task: 'do it' },
      async () => ({ approved: true }),
    );

    const record = await store.read(session.id);
    expect(record?.turns).toHaveLength(1);
    expect(record?.turns[0].output).toBeDefined();
  });
});
