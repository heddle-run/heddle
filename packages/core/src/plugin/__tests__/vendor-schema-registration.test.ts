/**
 * The vendored SDK's schema registration seam.
 *
 * `vendor/agentspec` carries a numbered patch series over an upstream copy, and
 * the refresh procedure overwrites `src/` wholesale — so a dropped patch does
 * not fail loudly. It fails as a missing export, somewhere downstream, in
 * heddle. VENDOR.md says as much and asks for a diff against upstream; a test is
 * the version of that which runs on its own.
 *
 * Patch 1 forwards `registerNodeUnionSchema` and `registerFlowSchema` from the
 * package root. They are the seam `plugin/flow-preprocess.ts` exists to work
 * around: with them, heddle can widen `NodeUnion` to admit a plugin's node types
 * instead of validating an `InputMessageNode` stand-in and swapping the real
 * component back in by id.
 *
 * Nothing in heddle calls them yet. That is the reason to test them rather than
 * a reason not to: an export with no caller is exactly the kind that a refresh
 * drops without anything noticing.
 *
 * The rebinding below is global to the SDK module, which is safe only because
 * vitest gives each test file its own module registry. Keep these tests here.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { NodeUnion, registerFlowSchema, registerNodeUnionSchema } from 'agentspec';
import { parseFlow } from '../../spec/parser.js';

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

afterEach(() => {
  // Put the SDK back the way it ships. A test that leaves the union rebound
  // would fail every later test in this file for a reason none of them names.
  registerNodeUnionSchema(NodeUnion);
});

describe('the vendored SDK schema registration', () => {
  it('exports both registration functions from the package root', () => {
    // Both, not just the node one: `LazyNodeRef` backs `Flow.nodes`,
    // `Flow.startNode` and both edge endpoints, while `LazyFlowRef` backs every
    // subflow position. A host that can rebind one and not the other gets a
    // widened top-level flow whose subflows still validate against the original.
    expect(typeof registerNodeUnionSchema).toBe('function');
    expect(typeof registerFlowSchema).toBe('function');
  });

  it('is the schema a flow is really validated against', () => {
    // The point of the patch is not that two symbols exist — it is that they
    // reach the schema `FlowSchema.parse` resolves at parse time. Rebinding the
    // union to one that refuses everything, and watching a flow that parsed a
    // moment ago stop parsing, is what distinguishes the live seam from a
    // re-export of something the SDK no longer consults.
    expect(parseFlow(FLOW).name).toBe('plain');

    registerNodeUnionSchema(NodeUnion.refine(() => false, 'rebound by the test'));
    expect(() => parseFlow(FLOW)).toThrow(/rebound by the test/);

    registerNodeUnionSchema(NodeUnion);
    expect(parseFlow(FLOW).name).toBe('plain');
  });
});
