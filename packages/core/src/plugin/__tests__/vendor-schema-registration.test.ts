/**
 * The vendored SDK's schema registration seams.
 *
 * `vendor/agentspec` carries a numbered patch series over an upstream copy, and
 * the refresh procedure overwrites `src/` wholesale — so a dropped patch does
 * not fail loudly. It fails as a missing export, somewhere downstream, in
 * heddle. VENDOR.md says as much and asks for a diff against upstream; a test is
 * the version of that which runs on its own.
 *
 * Three patches, three seams, and each opens a different closed union:
 *
 * - **1** forwards `registerNodeUnionSchema` and `registerFlowSchema`, which
 *   open `Flow.nodes` to a plugin's node types.
 * - **2** adds `registerMessageTransformSchema`, which opens
 *   `Agent.transforms`.
 * - **3** adds `registerLlmConfigSchema`, which opens all four `llm_config`
 *   positions at once.
 *
 * `spec/open-unions.ts` calls all but `registerFlowSchema`, which stays
 * deliberately uncalled — `LazyFlowRef` resolves to `FlowSchema`, whose nodes
 * are already `LazyNodeRef`, so subflows widen transitively. An export with no
 * caller is exactly the kind a refresh drops without anything noticing, which is
 * the reason to test it rather than a reason not to.
 *
 * Each seam is tested by *rebinding* it and watching a document that parsed a
 * moment ago stop parsing. That is what distinguishes a live seam from a
 * re-export of something the SDK no longer consults. The rebinding is global to
 * the SDK module, which is safe only because vitest gives each test file its own
 * module registry. Keep these tests here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  LlmConfigUnion,
  MessageTransformUnion,
  NodeUnion,
  registerFlowSchema,
  registerLlmConfigSchema,
  registerMessageTransformSchema,
  registerNodeUnionSchema,
} from 'agentspec';
import { parseFlow } from '../../spec/parser.js';
import { installWidenedUnions } from '../../spec/open-unions.js';

/** start -> end, using nothing but builtins. */
const FLOW = JSON.stringify({
  component_type: 'Flow',
  name: 'plain',
  start_node: { $component_ref: 's' },
  nodes: [{ $component_ref: 's' }, { $component_ref: 'e' }],
  control_flow_connections: [
    {
      component_type: 'ControlFlowEdge',
      name: 'go',
      from_node: { $component_ref: 's' },
      to_node: { $component_ref: 'e' },
    },
  ],
  $referenced_components: {
    s: { component_type: 'StartNode', id: 's', name: 's', outputs: [] },
    e: { component_type: 'EndNode', id: 'e', name: 'e' },
  },
});

/** start -> an agent carrying an llm_config and a transform -> end. */
const AGENT_FLOW = JSON.stringify({
  component_type: 'Flow',
  name: 'agenty',
  start_node: { $component_ref: 's' },
  nodes: [{ $component_ref: 's' }, { $component_ref: 'a' }, { $component_ref: 'e' }],
  control_flow_connections: [
    {
      component_type: 'ControlFlowEdge',
      name: 'go',
      from_node: { $component_ref: 's' },
      to_node: { $component_ref: 'a' },
    },
    {
      component_type: 'ControlFlowEdge',
      name: 'done',
      from_node: { $component_ref: 'a' },
      to_node: { $component_ref: 'e' },
    },
  ],
  $referenced_components: {
    s: { component_type: 'StartNode', id: 's', name: 's', outputs: [] },
    a: {
      component_type: 'AgentNode',
      id: 'a',
      name: 'a',
      agent: {
        component_type: 'Agent',
        name: 'assistant',
        system_prompt: 'hi',
        llm_config: {
          component_type: 'OpenAiConfig',
          name: 'llm',
          model_id: 'gpt-4o-mini',
        },
      },
    },
    e: { component_type: 'EndNode', id: 'e', name: 'e' },
  },
});

afterEach(() => {
  // Put the SDK back the way heddle configures it — the *widened* schemas, not
  // the raw unions. `installWidenedUnions` is idempotent and latched, so it
  // will not re-register on its own; restoring the raw union instead would
  // leave every later test in this file running against a differently
  // configured SDK for a reason none of them names.
  registerNodeUnionSchema(NodeUnion);
  registerMessageTransformSchema(MessageTransformUnion);
  registerLlmConfigSchema(LlmConfigUnion);
});

describe('the vendored SDK schema registration', () => {
  it('exports every registration function from the package root', () => {
    // `registerFlowSchema` alongside the rest even though nothing calls it:
    // `LazyNodeRef` backs `Flow.nodes`, `Flow.startNode` and both edge
    // endpoints, while `LazyFlowRef` backs every subflow position. A host that
    // can rebind one and not the other gets a widened top-level flow whose
    // subflows still validate against the original.
    expect(typeof registerNodeUnionSchema).toBe('function');
    expect(typeof registerFlowSchema).toBe('function');
    expect(typeof registerMessageTransformSchema).toBe('function');
    expect(typeof registerLlmConfigSchema).toBe('function');
  });

  it('is the schema a flow’s nodes are really validated against', () => {
    expect(parseFlow(FLOW).name).toBe('plain');

    registerNodeUnionSchema(NodeUnion.refine(() => false, 'nodes rebound by the test'));
    expect(() => parseFlow(FLOW)).toThrow(/nodes rebound by the test/);
  });

  it('is the schema an llm_config is really validated against', () => {
    // Patch 3, and the one that reaches furthest: this same registration backs
    // `Agent.llmConfig`, `LlmNode.llmConfig` and the `llm` on both transforms.
    expect(parseFlow(AGENT_FLOW).name).toBe('agenty');

    registerLlmConfigSchema(LlmConfigUnion.refine(() => false, 'llm rebound by the test'));
    expect(() => parseFlow(AGENT_FLOW)).toThrow(/llm rebound by the test/);
  });

  it('widens through the seams rather than around them', () => {
    // The property the whole arrangement rests on: heddle's widening is
    // installed *through* these functions, so a refresh that drops the exports
    // does not silently fall back to unwidened unions — it fails to compile.
    // Calling it again must change nothing, which is what lets every run in the
    // process share one registration.
    installWidenedUnions();
    installWidenedUnions();
    expect(parseFlow(FLOW).name).toBe('plain');
    expect(parseFlow(AGENT_FLOW).name).toBe('agenty');
  });
});
