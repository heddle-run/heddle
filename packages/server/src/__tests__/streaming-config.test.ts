import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from '../server.js';
import { boolEnv, resolveConfig } from '../config.js';

function agentFlow(): Record<string, unknown> {
  return {
    component_type: 'Flow',
    name: 'agent-flow',
    start_node: { $component_ref: 'start' },
    nodes: [
      { $component_ref: 'start' },
      { $component_ref: 'agent' },
      { $component_ref: 'end' },
    ],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'start_to_agent',
        from_node: { $component_ref: 'start' },
        to_node: { $component_ref: 'agent' },
      },
      {
        component_type: 'ControlFlowEdge',
        name: 'agent_to_end',
        from_node: { $component_ref: 'agent' },
        to_node: { $component_ref: 'end' },
      },
    ],
    $referenced_components: {
      start: {
        component_type: 'StartNode',
        id: 'start',
        name: 'start',
        outputs: [{ title: 'query', type: 'string' }],
      },
      agent: {
        component_type: 'AgentNode',
        id: 'agent',
        name: 'agent',
        agent: {
          component_type: 'Agent',
          id: 'inner-agent',
          name: 'inner-agent',
          system_prompt: 'be helpful',
          llm_config: {
            component_type: 'OpenAiConfig',
            id: 'llm',
            name: 'openai',
            model_id: 'gpt-4o',
          },
        },
      },
      end: { component_type: 'EndNode', id: 'end', name: 'end' },
    },
  };
}

const streamFlags: Array<boolean | undefined> = [];

let upstream: Server;
let upstreamUrl: string;

beforeAll(async () => {
  upstream = createHttpServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { stream?: boolean };
      streamFlags.push(body.stream);

      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            id: '1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'gpt-4o',
            choices: [{ index: 0, delta: { content: 'hi' } }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: '1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'gpt-4o',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: '1',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-4o',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
        }),
      );
    });
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const addr = upstream.address();
  if (addr === null || typeof addr === 'string') throw new Error('no upstream port');
  upstreamUrl = `http://127.0.0.1:${addr.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

async function runWith(stream: boolean | undefined): Promise<Response> {
  const server = createServer({
    stream,
    defaultLlmKey: 'test-key',
    defaultLlmUrl: upstreamUrl,
    log: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server port');

  try {
    return await fetch(`http://127.0.0.1:${addr.port}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow: agentFlow(), inputs: { query: 'hi' } }),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('HEDDLE_STREAM off', () => {
  it('sends a buffered request, and the run still produces the answer', async () => {
    streamFlags.length = 0;

    const res = await runWith(false);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: { result: 'hi' } });
    expect(streamFlags).toEqual([undefined]);
  });
});

describe('HEDDLE_STREAM unset', () => {
  it('streams, so the playground keeps its token deltas', async () => {
    streamFlags.length = 0;

    const res = await runWith(undefined);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: { result: 'hi' } });
    expect(streamFlags).toEqual([true]);
  });
});

describe('resolveConfig', () => {
  it('defaults streaming on', () => {
    expect(resolveConfig({}).stream).toBe(true);
  });

  it('keeps an explicit false', () => {
    expect(resolveConfig({ stream: false }).stream).toBe(false);
  });
});

describe('the entrypoint', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'heddle-server.ts'),
    'utf-8',
  );

  it('reads HEDDLE_STREAM into the config', () => {
    expect(source).toMatch(
      /stream:\s*boolEnv\('HEDDLE_STREAM',\s*process\.env\.HEDDLE_STREAM\)/,
    );
  });

  it('tells an operator the variable exists', () => {
    expect(source).toMatch(/HEDDLE_STREAM\s+Whether model calls stream/);
  });
});

describe('boolEnv', () => {
  it('reads the spellings an operator actually types', () => {
    expect(boolEnv('HEDDLE_STREAM', '0')).toBe(false);
    expect(boolEnv('HEDDLE_STREAM', 'false')).toBe(false);
    expect(boolEnv('HEDDLE_STREAM', 'OFF')).toBe(false);
    expect(boolEnv('HEDDLE_STREAM', '1')).toBe(true);
    expect(boolEnv('HEDDLE_STREAM', ' true ')).toBe(true);
  });

  it('treats unset and empty as "operator said nothing"', () => {
    expect(boolEnv('HEDDLE_STREAM', undefined)).toBeUndefined();
    expect(boolEnv('HEDDLE_STREAM', '')).toBeUndefined();
  });

  it('refuses a value it cannot read rather than silently defaulting on', () => {
    expect(() => boolEnv('HEDDLE_STREAM', 'disabled')).toThrow(
      /HEDDLE_STREAM must be one of .*got "disabled"/,
    );
  });
});
