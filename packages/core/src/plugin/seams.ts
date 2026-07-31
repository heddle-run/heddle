import { PluginError } from '../errors.js';

export type Seam =
  | 'node'
  | 'nodeError'
  | 'modelCall'
  | 'toolCall'
  | 'toolResult'
  | 'agentRound';

export type Half = 'before' | 'after';

export type BeforeAction = 'proceed' | 'modify' | 'replace' | 'reject';

export type AfterAction = 'pass' | 'replace' | 'retry' | 'fail';

export interface SeamDef {
  position: 'node' | 'modelCall' | 'toolCall' | 'toolResult' | 'agentRound';
  hooks: Half[];
  when: 'always' | 'error';
  before: BeforeAction[];
  after: AfterAction[];
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
    implemented: true,
  },
  modelCall: {
    position: 'modelCall',
    hooks: ['before', 'after'],
    when: 'always',
    before: ['proceed', 'modify', 'replace', 'reject'],
    after: ['pass', 'replace', 'retry', 'fail'],
    implemented: true,
  },
  toolCall: {
    position: 'toolCall',
    hooks: ['before', 'after'],
    when: 'always',
    before: ['proceed', 'modify', 'replace', 'reject'],
    after: ['pass', 'replace', 'fail'],
    implemented: true,
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
