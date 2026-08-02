/**
 * A conversation, and the position of whatever run has not finished it.
 *
 * Two records rather than one, and the split is the whole reason this module
 * has a shape. A transcript is small, ordered, and read on every turn; a
 * checkpoint is large, opaque, and read only when resuming. A store that keeps
 * them together loads the previous run's entire node-output map to answer
 * "hello".
 */

/** One exchange: what a run was given, and what it came to. */
export interface Turn {
  runId: string;
  at: string;
  /**
   * The flow that ran this turn.
   *
   * Per turn rather than per session, because nothing stops a caller running a
   * different flow against a conversation it already has — and a session that
   * claimed one flow while its turns came from two would be lying about the
   * more interesting of the two facts. A session's own `flow` is just the first
   * turn's, kept for listings.
   */
  flow?: string;
  /** The inputs the run was started with, history excluded. */
  input: Record<string, unknown>;
  /**
   * The run's final state.
   *
   * The state, not a rendered string. The chat UI this replaced stored
   * `formatResult(...)` — structure thrown away to produce something printable,
   * which is fine for a log and wrong for a record something else reads back.
   */
  output?: Record<string, unknown>;
  error?: { name: string; message: string };
}

export interface SessionRecord {
  id: string;
  /** Where the conversation came from. Advisory: nothing resolves it. */
  flow?: string;
  createdAt: string;
  /**
   * How many turns have been appended.
   *
   * The transcript's version and nothing else's — a checkpoint write does not
   * move it. Passed to {@link SessionStore.append} as `expect`, so a second
   * writer that arrived while this run was in flight is refused rather than
   * interleaved. See {@link SessionConflictError}.
   */
  version: number;
  turns: Turn[];
}

export interface SessionSummary {
  id: string;
  flow?: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  /** Whether a run left a checkpoint behind — see {@link Checkpoint}. */
  unfinished: boolean;
}

/**
 * Where a run stopped, in enough detail to start it again.
 *
 * At most one per session: a run either finished, leaving none, or did not,
 * leaving this. Written at node boundaries when a run is durable, and at a
 * suspension wherever one happens.
 */
export interface Checkpoint {
  runId: string;
  at: string;
  /** The node to re-enter. */
  node: string;
  /** `Runner.walk`'s carried state, as data. */
  carried: Record<string, unknown>;
  /** Every node output the walk had accumulated, by node name. */
  nodeOutputs: Record<string, Record<string, unknown>>;
  attempt: number;
  /** The inputs the run started with, so a resumed run reports the same turn. */
  input: Record<string, unknown>;
  /** Present only when a middleware stopped the run on a human. */
  suspension?: Suspension;
}

/**
 * A run stopped on a question, and what it needs back to carry on.
 *
 * `resume` is the executor's own bookmark — for an agent, the messages it had
 * built and the tool call it was about to make. It is opaque to everything
 * outside the executor that wrote it, which is what keeps the runner from
 * having to understand the inside of a node it is only re-entering.
 */
export interface Suspension {
  /** Which middleware stopped it. */
  by: string;
  /** Which seam it stopped at. */
  seam: string;
  /** What is being asked of the human. The middleware's own shape. */
  ask: Record<string, unknown>;
  /** The node that was running. */
  node: string;
  /** Opaque to the runner; read only by the executor that resumes. */
  resume: Record<string, unknown>;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
}
