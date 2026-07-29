/**
 * Lazy schema reference for MessageTransformUnion.
 *
 * Mirrors flows/lazy-schemas.ts, and exists for the same reason that one does:
 * a `z.lazy()` callback runs at `.parse()` time rather than at module load, so
 * the value behind it can be settled after every module has finished
 * evaluating. There the motive was a genuine import cycle; here it is that a
 * host embedding this SDK may need `Agent.transforms` to admit a component type
 * the SDK does not ship, which a closed discriminated union cannot express.
 *
 * The default is `z.never()`, not the permissive `z.record(z.unknown())` its
 * sibling uses. The difference matters in exactly one situation and it is the
 * one worth optimising for: if `message-transform.js` is never evaluated —
 * because a consumer imported this module directly rather than through the
 * barrel — then nothing has registered, and a permissive default would silently
 * accept any object as a transform. `z.never()` refuses everything instead, so
 * that mistake shows up as every transform failing at once rather than as
 * validation quietly not happening.
 */
import { z } from "zod";

let _messageTransformUnionSchema: z.ZodType = z.never();

/** Lazy reference to MessageTransformUnion — validates at .parse() time. */
export const LazyMessageTransformRef: z.ZodType<Record<string, unknown>> =
  z.lazy(() => _messageTransformUnionSchema) as z.ZodType<
    Record<string, unknown>
  >;

/** Called from message-transform.ts after MessageTransformUnion is defined. */
export function registerMessageTransformSchema(schema: z.ZodType): void {
  _messageTransformUnionSchema = schema;
}
