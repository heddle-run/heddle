/**
 * Opens the SDK's closed unions, once, without knowing what a plugin is.
 *
 * Agent Spec validates `Flow.nodes` against a discriminated union of builtin
 * node types and `Agent.transforms` against one of the two builtin transforms.
 * A flow carrying a custom component was therefore rejected before any plugin
 * ran — which is why heddle used to hand the SDK a stand-in node with
 * synthesized fields and swap the real one back afterwards, keyed by id
 * (`plugin/flow-preprocess.ts`, as it was). That machinery is what this module
 * replaces.
 *
 * ---
 *
 * **The registration knows nothing about which plugins are loaded, and that is
 * the whole design.** The obvious implementation — register `NodeUnion` widened
 * with *this run's* plugin schemas — cannot be made safe here.
 * `registerNodeUnionSchema` writes a module-global that `z.lazy()` reads at
 * parse time, and heddle builds a `PluginRegistry` per run: on the server, per
 * request, with concurrent runs in one process. Run A's registration is visible
 * to run B's parse.
 *
 * Save-and-restore around a synchronous parse would work today, and only today.
 * Its correctness rests on no `await` ever appearing between the write and the
 * restore — an invariant that is invisible, untyped, and one refactor away from
 * a caller's flow being validated against a different caller's plugin set. That
 * is the opposite of the property the server exists to have, and a failure that
 * would not crash: it would quietly accept.
 *
 * So the widened schema asks one question — is this `componentType` a builtin? —
 * whose answer is a pure lookup into a frozen table and is identical in every
 * run forever. Nothing run-scoped reaches the global, so there is nothing to
 * restore, no ordering hazard, and `parseFlow` stays synchronous and reentrant:
 * a nested subflow parse, or a plugin `validate()` that itself parses, reads the
 * same immutable schema.
 *
 * **What this gives up is slot discipline.** The union was checking, for free,
 * that a transform is not written into `Flow.nodes`. It no longer can, because
 * it cannot tell a plugin's node from a plugin's transform without knowing the
 * plugin. Four checks downstream take that over, and each names the kind:
 * `toSpecNode` (`spec/adapter.ts`), `TransformChain.build`
 * (`plugin/transform.ts`), `providerFor` (`llm/provider.ts`) and the compiler's
 * default branch (`graph/compile.ts`). The first three run before anything
 * executes; `providerFor` runs at the first model call, because that is when a
 * provider is built at all.
 *
 * **What it does not give up is anything about builtins.** A builtin
 * `componentType` goes to the original union with its issues and its parsed
 * output unchanged, so a malformed `StartNode`, an `OllamaConfig` in `nodes[]`
 * and an `Agent` in a node slot all still fail exactly as they did — same
 * message, same path. There is a test that pins that byte for byte.
 *
 * `registerFlowSchema` is deliberately never called. `LazyFlowRef` resolves to
 * `FlowSchema`, whose `startNode` and `nodes` are already `LazyNodeRef`, so
 * every subflow position widens through this registration transitively. A
 * second registration would be redundant, not additive.
 */
import { z } from 'zod';
import {
  isBuiltinComponentType,
  LlmConfigUnion,
  MessageTransformUnion,
  NodeUnion,
  registerLlmConfigSchema,
  registerMessageTransformSchema,
  registerNodeUnionSchema,
} from 'agentspec';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One slot, widened to admit a component type the SDK does not know.
 *
 * `id` and `name` are the two fields the widened branch still insists on, and
 * they are not arbitrary: `createFlow`'s invariant checks, `assertNodeInFlow`
 * and both edge endpoint schemas read exactly those. A custom component missing
 * either would pass this union and fail further in, with a message about an
 * edge rather than about the component.
 */
function widen(union: z.ZodTypeAny, slot: string): z.ZodType<Record<string, unknown>> {
  return z.any().transform((value: unknown, ctx: z.RefinementCtx) => {
    const component = isPlainObject(value) ? value : undefined;
    const componentType = component?.componentType;

    if (
      component &&
      typeof componentType === 'string' &&
      !isBuiltinComponentType(componentType)
    ) {
      if (
        typeof component.id !== 'string' ||
        component.id.length === 0 ||
        typeof component.name !== 'string'
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `${slot} of type "${componentType}" needs a non-empty "id" and a "name". ` +
            `heddle assigns both when it deserializes a plugin component, so seeing ` +
            `this means the component reached the SDK by another route.`,
        });
        return z.NEVER;
      }
      // Through untouched. Re-parsing it here would be heddle deciding what a
      // plugin component looks like, which is the plugin's own business — and
      // its manifest `schema` is where that is already checked.
      return component;
    }

    // Builtins, and anything with no usable `componentType`: the original union,
    // its issues forwarded whole so the message and the path a consumer sees are
    // the ones the SDK would have produced on its own.
    const parsed = union.safeParse(value);
    if (parsed.success) return parsed.data as Record<string, unknown>;
    for (const issue of parsed.error.issues) ctx.addIssue(issue);
    return z.NEVER;
  }) as unknown as z.ZodType<Record<string, unknown>>;
}

let installed = false;

/**
 * Install the widened unions. Idempotent, and called at module scope from
 * `spec/parser.ts`.
 *
 * An explicit call rather than a bare side-effecting import, for two reasons: a
 * linter or a bundler cannot drop it as unused, and a test can assert that
 * calling it twice changes nothing — which is the property that makes it safe
 * for every run in the process to share one registration.
 */
export function installWidenedUnions(): void {
  if (installed) return;
  installed = true;
  registerNodeUnionSchema(widen(NodeUnion, 'node'));
  registerMessageTransformSchema(widen(MessageTransformUnion, 'transform'));
  // One call, four slots — `Agent.llmConfig`, `LlmNode.llmConfig` and the `llm`
  // on both message transforms all read this union. That breadth is why paying
  // for a stand-in here would have cost three restore paths rebuilding a frozen
  // ancestor apiece, and it is why this registration buys the most.
  registerLlmConfigSchema(widen(LlmConfigUnion, 'llm config'));
}
