/**
 * Where a middleware may intervene, as data.
 *
 * Every other kind of plugin component occupies a slot the spec names: a flow
 * writes `component_type` into a document and heddle instantiates something
 * there. Middleware has no such slot, because most of what the engine does is
 * not a position anyone can name — there is no place in a spec that means
 * "around every node". A seam is that missing position, and this table is the
 * closed set of them.
 *
 * A table rather than a union of strings, because three separate things have to
 * agree about a seam and none of them can be trusted to remember: the manifest
 * validator has to refuse a subscription heddle will never honour, the host has
 * to refuse a verdict the call site cannot obey, and the plugin has to be told
 * both at the handshake so it learns its limits before it is mid-run. All three
 * read this.
 *
 * Only `nodeError` is implemented. The rest are listed anyway, and that is the
 * point of the table: a manifest naming `toolCall` today is refused with "not
 * yet consulted" rather than accepted into a silence, and the shape those seams
 * will need is fixed now, while nothing has been written against it.
 */
import { PluginError } from '../errors.js';

/** Every seam heddle will ever consult, implemented or not. */
export type Seam =
  | 'node'
  | 'nodeError'
  | 'modelCall'
  | 'toolCall'
  | 'toolResult'
  | 'agentRound';

/** Which half of a seam a subscription names. */
export type Half = 'before' | 'after';

/** What a `before` hook may answer. Nothing subscribes to one yet. */
export type BeforeAction = 'proceed' | 'modify' | 'replace' | 'reject';

/** What an `after` hook may answer. */
export type AfterAction = 'pass' | 'replace' | 'retry' | 'fail';

export interface SeamDef {
  /**
   * The call site this seam sits at. Two seams share a position when they are
   * two readings of one call — `node` runs on every dispatch and `nodeError`
   * only on a failed one, and they are one chain rather than two so that a
   * middleware's ordering against another middleware does not depend on which
   * of the two names it happened to subscribe under.
   */
  position: 'node' | 'modelCall' | 'toolCall' | 'toolResult' | 'agentRound';
  /** Which halves exist. `nodeError` has no `before`: nothing precedes an error. */
  hooks: Half[];
  /** Whether subscribers join the position's chain always, or only on failure. */
  when: 'always' | 'error';
  before: BeforeAction[];
  after: AfterAction[];
  /**
   * Whether heddle consults this seam today.
   *
   * `retry` is the reason the unimplemented rows carry their verdict sets
   * already. It is admissible at `node` because `runner.ts` writes nothing
   * before the call it would re-issue — `nodeOutputs.set` and the state merge
   * both follow the `try` — and it is inadmissible at `toolCall`, where the
   * earlier rounds of the tool loop are already in `messages` by the time a
   * call fails. That is not a limitation to be discovered later; it is a
   * property of those two call sites, and writing it down here is what stops
   * `retry` being spelled on a seam that could never honour it.
   */
  implemented: boolean;
}

export const SEAMS: Record<Seam, SeamDef> = {
  nodeError: {
    position: 'node',
    hooks: ['after'],
    when: 'error',
    before: [],
    after: ['pass', 'replace', 'retry', 'fail'],
    implemented: true,
  },
  node: {
    position: 'node',
    hooks: ['before', 'after'],
    when: 'always',
    before: ['proceed', 'modify', 'replace', 'reject'],
    after: ['pass', 'replace', 'fail'],
    implemented: false,
  },
  modelCall: {
    position: 'modelCall',
    hooks: ['before', 'after'],
    when: 'always',
    before: ['proceed', 'modify', 'replace', 'reject'],
    after: ['pass', 'replace', 'retry', 'fail'],
    implemented: false,
  },
  toolCall: {
    position: 'toolCall',
    hooks: ['before', 'after'],
    when: 'always',
    before: ['proceed', 'modify', 'replace', 'reject'],
    // No retry: by the time a tool call fails, the assistant message that
    // requested it is already in `messages` (node/agent.ts), so re-issuing the
    // call is not re-entering a clean state.
    after: ['pass', 'replace', 'fail'],
    implemented: false,
  },
  toolResult: {
    position: 'toolResult',
    hooks: ['after'],
    when: 'always',
    before: [],
    after: ['pass', 'replace'],
    implemented: false,
  },
  agentRound: {
    position: 'agentRound',
    hooks: ['before', 'after'],
    when: 'always',
    before: ['proceed', 'reject'],
    after: ['pass', 'fail'],
    implemented: false,
  },
};

export const SEAM_NAMES = Object.keys(SEAMS) as Seam[];

/** The seams heddle actually consults, for an error message worth reading. */
export const IMPLEMENTED_SEAMS = SEAM_NAMES.filter((name) => SEAMS[name].implemented);

export function isSeam(value: unknown): value is Seam {
  return typeof value === 'string' && Object.hasOwn(SEAMS, value);
}

export function isHalf(value: unknown): value is Half {
  return value === 'before' || value === 'after';
}

/**
 * What one plugin component subscribes to: a seam, and which of its halves.
 *
 * Halves are declared rather than inferred from which handlers the plugin
 * happens to export, because heddle has to know before the process starts. A
 * chain that discovered its subscribers by calling them would pay a round trip
 * per node per middleware to find out that most of them do nothing.
 */
export type SeamSubscription = Partial<Record<Seam, Half[]>>;

/**
 * Read a subscription, refusing everything heddle cannot honour.
 *
 * Here rather than in the manifest validator because the manifest is not the
 * only way a subscription arrives. An in-process plugin writes one as a
 * TypeScript object literal, where `seams: { toolCall: ['after'] }` type-checks
 * — `toolCall` is a `Seam` — and would then load cleanly, print in
 * `--verbose`, and never be consulted. A middleware that is silently never
 * called reads to its author as a middleware that does not work, and nothing
 * about being written in the same process as heddle earns that.
 *
 * Four refusals, because they send four different people to four different
 * fixes: a subscription with nothing in it, a seam name heddle has never heard
 * of, a seam heddle knows about but does not yet consult, and a half the seam
 * does not have. That third one is why {@link SEAMS} lists the unimplemented
 * rows at all.
 *
 * The halves matter as much as the seam, and this is the check that makes them
 * mean something: a component declaring `nodeError: ['before']` is refused
 * here, where the alternative is a chain that keys on the seam alone and calls
 * the `after` of something that said it hooked the other half.
 */
export function readSubscription(where: string, value: unknown): SeamSubscription {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginError(
      `${where} is a middleware and must declare "seams": an object mapping a seam ` +
        `to the halves it hooks, such as { "nodeError": ["after"] }. Consulted ` +
        `today: ${IMPLEMENTED_SEAMS.join(', ')}.`,
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new PluginError(
      `${where} declares "seams" with nothing in it, so nothing would ever call it`,
    );
  }

  const seams: SeamSubscription = {};
  for (const [name, halves] of entries) {
    if (!isSeam(name)) {
      throw new PluginError(
        `${where} subscribes to "${name}", which is not a seam. heddle's seams are: ` +
          `${SEAM_NAMES.join(', ')}.`,
      );
    }
    const def = SEAMS[name];
    if (!def.implemented) {
      throw new PluginError(
        `${where} subscribes to "${name}", which heddle does not consult yet. ` +
          `Consulted today: ${IMPLEMENTED_SEAMS.join(', ')}.`,
      );
    }
    if (!Array.isArray(halves) || halves.length === 0 || !halves.every(isHalf)) {
      throw new PluginError(
        `${where}: seams.${name} must be a non-empty array of "before" and/or ` +
          `"after". This seam has: ${def.hooks.join(', ')}.`,
      );
    }
    for (const half of halves as Half[]) {
      if (!def.hooks.includes(half)) {
        throw new PluginError(
          `${where} hooks the "${half}" half of "${name}", which has no such half. ` +
            `"${name}" has: ${def.hooks.join(', ')}. Nothing precedes an error, so ` +
            `nodeError is consulted only after one.`,
        );
      }
    }
    seams[name] = [...new Set(halves as Half[])];
  }

  return seams;
}
