import { PluginError } from '../errors.js';

export type Seam =
  | 'node'
  | 'nodeError'
  | 'modelCall'
  | 'toolCall'
  | 'agentRound';

export type Half = 'before' | 'after';

export type BeforeAction = 'proceed' | 'modify' | 'replace' | 'reject';

export type AfterAction = 'pass' | 'replace' | 'retry' | 'fail';

/**
 * What a seam admits, and where.
 *
 * Every field here is read: `hooks` by the subscription reader, `before` and
 * `after` by the verdict readers, `implemented` by both of those and by the
 * handshake. Two more fields lived here until they did not — `position` and
 * `when`, which said which call site a seam wrapped and whether it fired on
 * failures only. Both were true and neither was ever read, and the table a
 * reader would consult for that is prose in the docs rather than generated from
 * here. A field a program does not read is a comment with a type annotation, so
 * they are comments now.
 */
export interface SeamDef {
  hooks: Half[];
  before: BeforeAction[];
  after: AfterAction[];
  implemented: boolean;
}

export const SEAMS: Record<Seam, SeamDef> = {
  /** Around a node, and only when it failed — nothing precedes an error. */
  nodeError: {
    hooks: ['after'],
    before: [],
    after: ['pass', 'replace', 'retry', 'fail'],
    implemented: true,
  },
  /**
   * Around a node whether it failed or not, and the widest seam there is.
   * Shares its call site with `nodeError`, which nests inside it and owns the
   * retries — which is why nothing here admits one.
   */
  node: {
    hooks: ['before', 'after'],
    before: ['proceed', 'modify', 'replace', 'reject'],
    after: ['pass', 'replace', 'fail'],
    implemented: true,
  },
  /** Around a request to the model. The only seam that admits a retry. */
  modelCall: {
    hooks: ['before', 'after'],
    before: ['proceed', 'modify', 'replace', 'reject'],
    after: ['pass', 'replace', 'retry', 'fail'],
    implemented: true,
  },
  /**
   * Around a tool *the model asked for*. No retry: the request is already said.
   *
   * The emphasis is load-bearing. Every tool is on `$PATH` inside the node's
   * workspace, so a tool that exec's a peer never reaches this call site — a
   * verdict here governs what the model may ask for, not what the machine may
   * do. The controls over the machine are the sandbox's. `--no-mount-tools`
   * empties the workspace's bin for an operator who needs this to be a gate.
   */
  toolCall: {
    hooks: ['before', 'after'],
    before: ['proceed', 'modify', 'replace', 'reject'],
    after: ['pass', 'replace', 'fail'],
    implemented: true,
  },
  /** Around one model call and the tool calls it asked for. A guard, nothing more. */
  agentRound: {
    hooks: ['before', 'after'],
    before: ['proceed', 'reject'],
    after: ['pass', 'fail'],
    implemented: true,
  },
};

export const SEAM_NAMES = Object.keys(SEAMS) as Seam[];

export const IMPLEMENTED_SEAMS = SEAM_NAMES.filter(
  (name) => SEAMS[name].implemented,
);

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
  if (!SEAMS[name].implemented) {
    throw new PluginError(
      `${where} subscribes to "${name}", which heddle does not consult yet. ` +
        `Consulted today: ${IMPLEMENTED_SEAMS.join(', ')}.`,
    );
  }
  return name;
}

function readHalves(where: string, seam: Seam, halves: unknown): Half[] {
  const def = SEAMS[seam];

  if (!Array.isArray(halves) || halves.length === 0 || !halves.every(isHalf)) {
    throw new PluginError(
      `${where}: seams.${seam} must be a non-empty array of "before" and/or ` +
        `"after". This seam has: ${def.hooks.join(', ')}.`,
    );
  }

  for (const half of halves) {
    if (!def.hooks.includes(half)) {
      throw new PluginError(unsupportedHalfMessage(where, seam, half, def));
    }
  }

  return [...new Set(halves)];
}

function missingSeamsMessage(where: string): string {
  return (
    `${where} is a middleware and must declare "seams": an object mapping a seam ` +
    `to the halves it hooks, such as { "nodeError": ["after"] }. Consulted ` +
    `today: ${IMPLEMENTED_SEAMS.join(', ')}.`
  );
}

function unsupportedHalfMessage(
  where: string,
  seam: Seam,
  half: Half,
  def: SeamDef,
): string {
  return (
    `${where} hooks the "${half}" half of "${seam}", which has no such half. ` +
    `"${seam}" has: ${def.hooks.join(', ')}. Nothing precedes an error, so ` +
    `nodeError is consulted only after one.`
  );
}
