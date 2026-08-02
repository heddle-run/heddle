import { PluginError } from '../errors.js';

export type Seam =
  | 'node'
  | 'nodeError'
  | 'modelCall'
  | 'toolCall'
  | 'agentRound';

export type Half = 'before' | 'after';

export type BeforeAction =
  | 'proceed'
  | 'modify'
  | 'replace'
  | 'reject'
  | 'suspend';

export type AfterAction = 'pass' | 'replace' | 'retry' | 'fail';

/**
 * What a seam admits, and where.
 *
 * Every field here is read: `before` and `after` by the verdict readers, and
 * the halves a seam has fall out of them — see {@link hooksOf}. Two more
 * fields lived here until they did not — `position` and `when`, which said
 * which call site a seam wrapped and whether it fired on failures only. Both
 * were true and neither was ever read, and the table a reader would consult
 * for that is prose in the docs rather than generated from here. A field a
 * program does not read is a comment with a type annotation, so they are
 * comments now.
 */
export interface SeamDef {
  before: BeforeAction[];
  after: AfterAction[];
}

export const SEAMS: Record<Seam, SeamDef> = {
  /** Around a node, and only when it failed — nothing precedes an error. */
  nodeError: {
    before: [],
    after: ['pass', 'replace', 'retry', 'fail'],
  },
  /**
   * Around a node whether it failed or not, and the widest seam there is.
   * Shares its call site with `nodeError`, which nests inside it and owns the
   * retries — which is why nothing here admits one.
   */
  node: {
    before: ['proceed', 'modify', 'replace', 'reject', 'suspend'],
    after: ['pass', 'replace', 'fail'],
  },
  /**
   * Around a request to the model. The only seam that admits a retry.
   *
   * No `suspend`, and the reason is the same one that keeps `retry` off
   * `toolCall`: a suspension has to be resumable, and what would be resumed
   * here is a request the run has not decided to make yet. A policy wanting a
   * human before the model is consulted asks at `node`, which is the boundary
   * that owns whether this node runs at all.
   */
  modelCall: {
    before: ['proceed', 'modify', 'replace', 'reject'],
    after: ['pass', 'replace', 'retry', 'fail'],
  },
  /**
   * Around a tool *the model asked for*. No retry: the request is already said.
   *
   * The emphasis is load-bearing. Every tool is on `$PATH` inside the node's
   * workspace, so a tool that exec's a peer never reaches this call site — a
   * verdict here governs what the model may ask for, not what the machine may
   * do. The controls over the machine are the sandbox's. `--no-mount-tools`
   * empties the workspace's bin for an operator who needs this to be a gate.
   *
   * It is also the seam an approval gate lives at, and the reason `suspend`
   * exists. `reject` already expresses "no" — the model is told and carries on
   * — but "ask somebody and come back" needs the run to stop and start again,
   * which is a different thing entirely. The caveat above applies to it too: a
   * suspension gates the model's request, not the machine.
   */
  toolCall: {
    before: ['proceed', 'modify', 'replace', 'reject', 'suspend'],
    after: ['pass', 'replace', 'fail'],
  },
  /** Around one model call and the tool calls it asked for. A guard, nothing more. */
  agentRound: {
    before: ['proceed', 'reject'],
    after: ['pass', 'fail'],
  },
};

export const SEAM_NAMES = Object.keys(SEAMS) as Seam[];

/** The halves a seam has: the ones that admit something. */
function hooksOf(def: SeamDef): Half[] {
  const hooks: Half[] = [];
  if (def.before.length > 0) hooks.push('before');
  if (def.after.length > 0) hooks.push('after');
  return hooks;
}

export type SeamSubscription = Partial<Record<Seam, Half[]>>;

export function isSeam(value: unknown): value is Seam {
  return typeof value === 'string' && Object.hasOwn(SEAMS, value);
}

export function isHalf(value: unknown): value is Half {
  return value === 'before' || value === 'after';
}

export function readSubscription(
  where: string,
  value: unknown,
): SeamSubscription {
  const entries = readEntries(where, value);

  const subscription: SeamSubscription = {};
  for (const [name, halves] of entries) {
    const seam = readSeamName(where, name);
    subscription[seam] = readHalves(where, seam, halves);
  }
  return subscription;
}

function readEntries(
  where: string,
  value: unknown,
): Array<[string, unknown]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PluginError(missingSeamsMessage(where));
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new PluginError(
      `${where} declares "seams" with nothing in it, so nothing would ever call it`,
    );
  }
  return entries;
}

function readSeamName(where: string, name: string): Seam {
  if (!isSeam(name)) {
    throw new PluginError(
      `${where} subscribes to "${name}", which is not a seam. heddle's seams are: ` +
        `${SEAM_NAMES.join(', ')}.`,
    );
  }
  return name;
}

function readHalves(where: string, seam: Seam, halves: unknown): Half[] {
  const hooks = hooksOf(SEAMS[seam]);

  if (!Array.isArray(halves) || halves.length === 0 || !halves.every(isHalf)) {
    throw new PluginError(
      `${where}: seams.${seam} must be a non-empty array of "before" and/or ` +
        `"after". This seam has: ${hooks.join(', ')}.`,
    );
  }

  for (const half of halves) {
    if (!hooks.includes(half)) {
      throw new PluginError(unsupportedHalfMessage(where, seam, half, hooks));
    }
  }

  return [...new Set(halves)];
}

function missingSeamsMessage(where: string): string {
  return (
    `${where} is a middleware and must declare "seams": an object mapping a seam ` +
    `to the halves it hooks, such as { "nodeError": ["after"] }. Consulted ` +
    `today: ${SEAM_NAMES.join(', ')}.`
  );
}

function unsupportedHalfMessage(
  where: string,
  seam: Seam,
  half: Half,
  hooks: Half[],
): string {
  return (
    `${where} hooks the "${half}" half of "${seam}", which has no such half. ` +
    `"${seam}" has: ${hooks.join(', ')}. Nothing precedes an error, so ` +
    `nodeError is consulted only after one.`
  );
}
