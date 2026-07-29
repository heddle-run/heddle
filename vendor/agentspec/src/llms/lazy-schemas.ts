/**
 * Lazy schema reference for LlmConfigUnion.
 *
 * The third of these, and the same shape as the other two: a `z.lazy()`
 * callback runs at `.parse()` time rather than at module load, so what sits
 * behind it can be settled after every module has finished evaluating. In
 * `flows/lazy-schemas.ts` the motive was a genuine import cycle; here — as in
 * `transforms/lazy-schemas.ts` — it is that a host embedding this SDK may need
 * an `llm_config` position to admit a config type the SDK does not ship, which
 * a closed discriminated union cannot express.
 *
 * This one is read from more positions than either sibling. `LlmConfigUnion`
 * gates `Agent.llmConfig`, `LlmNode.llmConfig` and the `llm` on both message
 * transforms, so one registration widens four slots at once — which is why
 * paying for a stand-in config instead was the most expensive workaround in the
 * codebase.
 *
 * The default is `z.never()`, matching the transform ref rather than the
 * permissive `z.record(z.unknown())` the flow refs use. If `llms/index.js` is
 * never evaluated, nothing has registered, and a permissive default would
 * silently accept any object as a model configuration — including one naming no
 * model at all. `z.never()` refuses everything instead, so that mistake shows up
 * as every config failing at once rather than as validation quietly not
 * happening.
 */
import { z } from "zod";

let _llmConfigUnionSchema: z.ZodType = z.never();

/** Lazy reference to LlmConfigUnion — validates at .parse() time. */
export const LazyLlmConfigRef: z.ZodType<Record<string, unknown>> = z.lazy(
  () => _llmConfigUnionSchema,
) as z.ZodType<Record<string, unknown>>;

/** Called from llms/index.ts after LlmConfigUnion is defined. */
export function registerLlmConfigSchema(schema: z.ZodType): void {
  _llmConfigUnionSchema = schema;
}
