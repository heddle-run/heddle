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

/** Run `heddle validate` over a spec written to a temporary file. */
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

const START = {
  component_type: 'StartNode',
  id: 's',
  name: 'start',
  outputs: [{ title: 'query', type: 'string' }],
  branches: ['next'],
};

const END = {
  component_type: 'EndNode',
  id: 'e',
  name: 'end',
  inputs: [{ title: 'result', type: 'string' }],
  branches: [],
};

const LLM = {
  component_type: 'LlmNode',
  id: 'draft',
  name: 'draft',
  prompt_template: 'Summarise: {{query}}',
  llm_config: {
    component_type: 'OpenAiConfig',
    name: 'gpt',
    model_id: 'gpt-4o-mini',
  },
  outputs: [{ title: 'summary', type: 'string' }],
  branches: ['next'],
};

function edge(name: string, from: string, to: string, branch?: string) {
  return {
    component_type: 'ControlFlowEdge',
    name,
    from_node: { $component_ref: from },
    from_branch: branch ?? null,
    to_node: { $component_ref: to },
  };
}

function flow(
  referenced: Record<string, unknown>,
  control: unknown[],
  data: unknown[] = [],
) {
  return {
    component_type: 'Flow',
    agentspec_version: '26.2.0',
    name: 'test-flow',
    start_node: { $component_ref: 's' },
    nodes: Object.keys(referenced).map((ref) => ({ $component_ref: ref })),
    control_flow_connections: control,
    data_flow_connections: data,
    $referenced_components: referenced,
  };
}

describe('heddle validate', () => {
  it('passes a flow with nothing wrong with it', async () => {
    const out = await validateSpec(
      flow({ s: START, e: END }, [edge('s_to_e', 's', 'e')]),
    );

    expect(out).toContain('Graph validation passed');
    expect(out).toContain('Valid:');
  });

  it('fails a mapping to a branch no edge leaves on', async () => {
    const router = {
      component_type: 'BranchingNode',
      id: 'r',
      name: 'router',
      inputs: [{ title: 'branching_mapping_key', type: 'string' }],
      branches: ['yes_branch', 'nowhere_branch'],
      mapping: { yes: 'yes_branch', no: 'nowhere_branch' },
    };

    await expect(
      validateSpec(
        flow({ s: START, r: router, e: END }, [
          edge('s_to_r', 's', 'r'),
          edge('r_to_e', 'r', 'e', 'yes_branch'),
        ]),
      ),
    ).rejects.toThrow(/maps "no" to branch "nowhere_branch"/);
  });

  it('fails a data flow edge reading what an LlmNode cannot produce', async () => {
    await expect(
      validateSpec(
        flow(
          { s: START, draft: LLM, e: END },
          [edge('s_to_draft', 's', 'draft'), edge('draft_to_e', 'draft', 'e')],
          [
            {
              component_type: 'DataFlowEdge',
              name: 'summary_out',
              source_node: { $component_ref: 'draft' },
              source_output: 'summary',
              destination_node: { $component_ref: 'e' },
              destination_input: 'result',
            },
          ],
        ),
      ),
    ).rejects.toThrow(/reads output "summary" from LlmNode "draft"/);
  });
});
