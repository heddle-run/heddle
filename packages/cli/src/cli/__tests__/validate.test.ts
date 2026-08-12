import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommand } from '../validate.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run `heddle validate` over a document written to a temporary file. */
async function validateSpec(spec: unknown): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-validate-'));
  dirs.push(dir);
  const path = join(dir, 'flow.json');
  writeFileSync(path, JSON.stringify(spec));

  let out = '';
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out += `${args.join(' ')}\n`;
  });

  await validateCommand.parseAsync([path], { from: 'user' });
  return out;
}

const MODEL = { provider: 'openai', model: 'gpt-4o-mini' };

function flow(over: Record<string, unknown> = {}) {
  return {
    weave: 1,
    name: 'test-flow',
    inputs: { query: 'string' },
    agent: {
      model: MODEL,
      prompt: 'Summarise: {{inputs.query}}',
    },
    ...over,
  };
}

describe('heddle validate', () => {
  it('passes a document with nothing wrong with it', async () => {
    const out = await validateSpec(flow());

    expect(out).toContain('Parsed flow: test-flow');
    expect(out).toContain('Graph validation passed');
    expect(out).toContain('Valid:');
  });

  it('fails a switch without an else, before anything is printed', async () => {
    await expect(
      validateSpec(
        flow({
          agent: undefined,
          steps: [
            {
              name: 'route',
              switch: '{{inputs.query}}',
              cases: { yes: 'done' },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/"else" is required/);
  });

  it('fails a reference to something that never runs', async () => {
    await expect(
      validateSpec(
        flow({
          agent: {
            model: MODEL,
            prompt: 'Summarise: {{draft.summary}}',
          },
        }),
      ),
    ).rejects.toThrow(/"draft" is not "inputs" or a step of this document/);
  });

  it('fails a step routing backward', async () => {
    await expect(
      validateSpec(
        flow({
          agent: undefined,
          steps: [
            { name: 'first', llm: { model: MODEL, prompt: 'one' } },
            {
              name: 'second',
              llm: { model: MODEL, prompt: 'two' },
              then: 'first',
            },
          ],
        }),
      ),
    ).rejects.toThrow(/routes back to "first"/);
  });

  it('refuses a key the format does not have', async () => {
    await expect(validateSpec(flow({ nodes: [] }))).rejects.toThrow(
      /unknown key "nodes"/,
    );
  });
});
