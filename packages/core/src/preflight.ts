import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join, sep } from 'node:path';
import { BundleError, RequirementError } from './errors.js';

/**
 * What an agent needs from the machine, declared and checked before a run.
 *
 * A bundle can already say what it needs; this is what makes saying it mean
 * something. The declaration travels in the manifest, and the check runs at the
 * same preflight point as the tool check — so a bundle that cannot work here
 * says so once, listing everything, instead of failing three times in a row at
 * whichever step reached the gap first.
 *
 * Every predicate is a pure observation of this machine: read `process.env`,
 * look on `$PATH`, `stat` a path, compare a version. Nothing here writes,
 * downloads, or spawns anything, and there is deliberately no predicate that
 * could. A `.heddle` file can be downloaded from anywhere, and the format's
 * whole premise is that opening one runs nothing — a requirement that executed
 * a declared command would be remote code execution wearing a preflight's
 * clothes. Installing what is missing is the operator's move, with their
 * package manager, after reading what this printed. (The CLI can make some of
 * those moves for them — see its `install-recipes.ts` — but every command it
 * offers comes from its own reviewed table, never from the declaration; a
 * requirement still only selects, and this module still only looks.)
 *
 * `hint` follows the same rule from the other direction: it is a string shown
 * to a human, and nothing anywhere passes it to a shell. Do not add a caller
 * that does.
 */

/** A name on `$PATH`, or several names of which any one will do. */
export interface BinaryRequirement {
  binary: string[];
  hint?: string;
}

/** An environment variable that must be set and non-empty. */
export interface EnvRequirement {
  env: string;
  hint?: string;
}

/** A path that must exist; a leading `~` is this machine's home. */
export interface FileRequirement {
  file: string;
  hint?: string;
}

/** A range the running Node must satisfy. */
export interface NodeRequirement {
  node: string;
  hint?: string;
}

export type Requirement =
  | BinaryRequirement
  | EnvRequirement
  | FileRequirement
  | NodeRequirement;

/** One requirement, checked. */
export interface CheckedRequirement {
  requirement: Requirement;
  /** How it is named in a report. */
  label: string;
  /** Why it does not hold, in a few words. Absent when it holds. */
  reason?: string;
  /**
   * What was found, when it holds: a resolved name, a version. Never a value
   * read out of the environment — see {@link checkEnv}.
   */
  found?: string;
}

/** A requirement that does not hold, and what is missing. */
export interface Unmet {
  requirement: Requirement;
  label: string;
  reason: string;
}

/** The comparison a `node` range may ask for. Anything else is refused. */
const NODE_RANGE = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

const KINDS = ['binary', 'env', 'file', 'node'] as const;

/** How many spellings of one binary a label names before it summarizes. */
const MAX_SHOWN_CANDIDATES = 3;

/**
 * C0 and C1 control characters, DEL included — refused in every string a
 * declaration carries. These strings are printed back to a terminal beside
 * words like "install this", and an escape sequence inside one could redraw
 * the report: hide an unmet line, make a hint read as something other than
 * what a copy-paste of it would run. Refused at the door rather than
 * sanitized at every printer, so no printer can forget.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Read a `requires` declaration, in either shape it may arrive in.
 *
 * The list of typed predicates is the shape; the older
 * `{ env: [...], binaries: [...] }` object is normalized into it here, in the
 * one place that reads either, so a `bundle.json` written before this existed
 * still packs and the website still renders it. Everything downstream — the
 * check, the manifest, the library pages — sees only the list.
 *
 * Throws {@link BundleError} on a declaration that cannot be read, naming the
 * entry: a `requires` heddle cannot evaluate is a bundle that would silently
 * check nothing, which is worse than one that will not pack.
 */
export function parseRequirements(raw: unknown): Requirement[] {
  if (raw === undefined || raw === null) return [];

  if (!Array.isArray(raw)) {
    return parseLegacy(raw);
  }

  return raw.map((entry, i) => parseRequirement(entry, `requires[${i}]`));
}

/**
 * Check every requirement and report all the failures.
 *
 * Deliberately not short-circuiting: the point of the whole feature is that
 * somebody with three things missing learns all three now, rather than finding
 * the second one after installing the first.
 */
export function checkRequirements(
  reqs: Requirement[],
  env: NodeJS.ProcessEnv = process.env,
): Unmet[] {
  return inspectRequirements(reqs, env)
    .filter((check) => check.reason !== undefined)
    .map(({ requirement, label, reason }) => ({
      requirement,
      label,
      reason: reason as string,
    }));
}

/**
 * The variables a declaration names, for a front end that would rather ask.
 *
 * The CLI asks for a missing one before this check refuses over it, which is
 * the difference between a bundle that needs a key and a bundle you cannot run
 * — see `askForEnvRefs`. Only the names travel; no value is read here.
 */
export function envRequirements(reqs: Requirement[]): string[] {
  return reqs
    .filter((requirement): requirement is EnvRequirement => 'env' in requirement)
    .map((requirement) => requirement.env);
}

/** Every requirement, held or not — what a report is rendered from. */
export function inspectRequirements(
  reqs: Requirement[],
  env: NodeJS.ProcessEnv = process.env,
): CheckedRequirement[] {
  return reqs.map((requirement) => check(requirement, env));
}

/**
 * Refuse to start when something is missing, saying everything that is.
 *
 * `context` is what the reader is holding — a bundle's name, a flow's — since
 * the message is read by somebody who ran one command and has no idea which of
 * its parts wants `ffmpeg`.
 */
export function assertRequirements(
  reqs: Requirement[],
  context: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (reqs.length === 0) return;

  const checks = inspectRequirements(reqs, env);
  if (!checks.some((entry) => entry.reason !== undefined)) return;

  throw new RequirementError(formatRequirements(context, checks));
}

/**
 * The report, in the shape both callers want it.
 *
 * Unmet ones get a line each, so none of them is the one you find out about
 * next time. Satisfied ones get a single summary line rather than a line each:
 * it says the check actually ran and looked at everything, without pushing the
 * failures off the top of a terminal.
 *
 * No colour. Nothing else in this CLI emits an escape sequence, and a report
 * that is read as often out of a CI log as off a terminal is better off legible
 * in both.
 */
export function formatRequirements(
  context: string,
  checks: CheckedRequirement[],
): string {
  if (checks.length === 0) return `${context} declares no requirements.\n`;

  const unmet = checks.filter((entry) => entry.reason !== undefined);
  const met = checks.filter((entry) => entry.reason === undefined);
  const satisfied = met.map((entry) => entry.found ?? entry.label).join(', ');

  if (unmet.length === 0) {
    const count = `${checks.length} requirement${checks.length === 1 ? '' : 's'}`;
    return `${context}: ${count}, all met.\n\n  ✓ ${satisfied}\n`;
  }

  const labels = Math.max(...unmet.map((entry) => entry.label.length));
  const reasons = Math.max(...unmet.map((entry) => (entry.reason as string).length));

  const lines = unmet.map((entry) => {
    const { hint } = entry.requirement;
    const reason = entry.reason as string;
    // The reason column is only padded when something follows it, so a line
    // with no hint does not end in trailing spaces.
    return (
      `  ✗ ${entry.label.padEnd(labels)}  ` +
      `${hint ? `${reason.padEnd(reasons)}  ${hint}` : reason}`
    );
  });

  const head =
    `${context} cannot run here — ${unmet.length} requirement` +
    `${unmet.length === 1 ? '' : 's'} unmet:`;

  return [
    head,
    '',
    ...lines,
    ...(met.length > 0 ? ['', `  ✓ ${satisfied}`] : []),
    '',
  ].join('\n');
}

/**
 * How a requirement is named, checked or not.
 *
 * One function so a bundle's summary at pack time, a `doctor` line and a run's
 * refusal all call the same thing what it is — an author who packed
 * "chromium or Google Chrome" should read those words back.
 *
 * Alternatives are deduplicated by their short name and then cut off, because
 * a declaration that mirrors what a tool searches can hold seven spellings of
 * "a browser", and a label that long turns a column of failures into wrapped
 * text. The hint is where the actionable sentence goes.
 */
export function requirementLabel(requirement: Requirement): string {
  if ('env' in requirement) return requirement.env;
  if ('file' in requirement) return requirement.file;
  if ('node' in requirement) return `node ${requirement.node}`;

  const names = [...new Set(requirement.binary.map(shortName))];
  const shown = names.slice(0, MAX_SHOWN_CANDIDATES).join(' or ');

  return names.length > MAX_SHOWN_CANDIDATES
    ? `${shown} (+${names.length - MAX_SHOWN_CANDIDATES} more)`
    : shown;
}

function check(
  requirement: Requirement,
  env: NodeJS.ProcessEnv,
): CheckedRequirement {
  if ('binary' in requirement) return checkBinary(requirement, env);
  if ('env' in requirement) return checkEnv(requirement, env);
  if ('file' in requirement) return checkFile(requirement);
  return checkNode(requirement);
}

/**
 * A name on `$PATH`, resolved here rather than by asking a shell.
 *
 * `which` would be a subprocess per requirement, and spawning one to find out
 * whether we may spawn things is the wrong shape for a check whose whole
 * promise is that it runs nothing. `$PATH` is a list of directories; reading it
 * is the entire algorithm.
 *
 * A candidate holding a separator is checked where it points instead, which is
 * what a shell does with `./tool` and what the machine-specific ones an author
 * writes — `/Applications/…/Google Chrome` — actually mean.
 *
 * No `PATHEXT` handling: this looks for the name as written, so on Windows a
 * requirement has to name `node.exe` if that is what it means. Being clear
 * about the gap beats guessing at extensions the declaration did not ask for.
 */
function checkBinary(
  requirement: BinaryRequirement,
  env: NodeJS.ProcessEnv,
): CheckedRequirement {
  const label = requirementLabel(requirement);

  for (const candidate of requirement.binary) {
    const found = isPath(candidate)
      ? isExecutableFile(candidate) && candidate
      : onPath(candidate, env);

    if (found) return { requirement, label, found: shortName(found) };
  }

  return {
    requirement,
    label,
    // "not on PATH" would be the wrong instruction for a requirement that named
    // only absolute paths — nothing about `$PATH` would satisfy it.
    reason: requirement.binary.every(isPath) ? 'not found' : 'not on PATH',
  };
}

/**
 * Set and non-empty — and never read into the report.
 *
 * The whole value of a variable like `OPENAI_API_KEY` is that it is a secret,
 * and this output is pasted into issues and scrolled past in CI logs. What the
 * report carries is the name and the word "set".
 */
function checkEnv(
  requirement: EnvRequirement,
  env: NodeJS.ProcessEnv,
): CheckedRequirement {
  const value = env[requirement.env];
  const isSet = typeof value === 'string' && value.length > 0;

  return {
    requirement,
    label: requirementLabel(requirement),
    ...(isSet ? {} : { reason: 'not set' }),
  };
}

function checkFile(requirement: FileRequirement): CheckedRequirement {
  const path = expandHome(requirement.file);

  return {
    requirement,
    label: requirementLabel(requirement),
    ...(existsSync(path) ? {} : { reason: 'not found' }),
  };
}

/**
 * The running Node against the range the bundle asked for.
 *
 * A `>=` against a version triple, and nothing else. There is no semver
 * dependency in core and this is not the place to acquire one, so what is
 * supported is what {@link NODE_RANGE} matches — and a range outside it is
 * refused when the declaration is read, rather than quietly passing here.
 */
function checkNode(requirement: NodeRequirement): CheckedRequirement {
  const running = process.versions.node;
  const label = requirementLabel(requirement);

  const wanted = parseNodeRange(requirement.node);
  if (wanted === undefined || !atLeast(running, wanted)) {
    return { requirement, label, reason: `have v${running}` };
  }
  return { requirement, label, found: `node v${running}` };
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;

    if (isExecutableFile(join(dir, name))) return name;
  }
  return undefined;
}

/** Written as somewhere to look rather than as a name to resolve. */
function isPath(candidate: string): boolean {
  return candidate.includes(sep) || candidate.includes('/');
}

function isExecutableFile(path: string): boolean {
  try {
    // Both halves matter: a directory is "executable" in the sense `access`
    // means — searchable — so the file check is what keeps a directory named
    // like a tool from satisfying a requirement for one.
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `~` and `~/…`, the one machine-relative path a declaration may carry. */
function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/** What a resolved binary is called, so a report says "Google Chrome". */
function shortName(candidate: string): string {
  return isPath(candidate) ? basename(candidate) : candidate;
}

function parseNodeRange(range: string): [number, number, number] | undefined {
  const match = NODE_RANGE.exec(range.trim());
  if (!match) return undefined;

  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function atLeast(running: string, wanted: [number, number, number]): boolean {
  // A prerelease suffix is dropped rather than ordered: Node's own versions do
  // not carry one, and a nightly claiming 25.0.0-pre is closer to 25.0.0 than
  // to nothing.
  const parts = running.split('-')[0].split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    if (have > wanted[i]) return true;
    if (have < wanted[i]) return false;
  }
  return true;
}

/**
 * The shape `requires` had before it could carry a hint.
 *
 * `{ env: [...], binaries: [...] }` is what every `library/*\/bundle.json`
 * says today and what the website read directly. Normalized rather than
 * deprecated: an entry that has not been rewritten is not broken, and one
 * reader for both shapes is what keeps the docs page and the run check from
 * disagreeing about what a bundle needs.
 */
function parseLegacy(raw: unknown): Requirement[] {
  const object = asObject(raw, 'requires');
  const unknown = Object.keys(object).filter(
    (key) => key !== 'env' && key !== 'binaries',
  );
  if (unknown.length > 0) {
    fail(
      `requires has ${unknown.map((key) => `"${key}"`).join(', ')}, which is ` +
        `neither the list form nor the older { env, binaries } object. Write ` +
        `it as a list: [{ "binary": "ffmpeg" }, { "env": "OPENAI_API_KEY" }].`,
    );
  }

  return [
    ...names(object.binaries, 'requires.binaries').map(
      (name): Requirement => ({ binary: [name] }),
    ),
    ...names(object.env, 'requires.env').map(
      (name): Requirement => ({ env: name }),
    ),
  ];
}

function names(raw: unknown, field: string): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${field} must be an array of names`);

  return raw.map((entry, i) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      fail(`${field}[${i}] must be a non-empty name`);
    }
    refusePlainTextEscapes(entry, `${field}[${i}]`);
    return entry.trim();
  });
}

function parseRequirement(raw: unknown, where: string): Requirement {
  const entry = asObject(raw, where);

  const kinds = KINDS.filter((kind) => entry[kind] !== undefined);
  if (kinds.length !== 1) {
    fail(
      `${where} must name exactly one of ${KINDS.join(', ')}` +
        `${kinds.length > 1 ? `; it names ${kinds.join(' and ')}` : ''}. A ` +
        `requirement is one thing to look for, so two of them are two entries.`,
    );
  }

  const hint = parseHint(entry.hint, where);
  const kind = kinds[0];

  if (kind === 'binary') {
    return { binary: candidates(entry.binary, where), ...hint };
  }
  if (kind === 'env') {
    return { env: text(entry.env, `${where}.env`), ...hint };
  }
  if (kind === 'file') {
    return { file: text(entry.file, `${where}.file`), ...hint };
  }

  const range = text(entry.node, `${where}.node`);
  if (parseNodeRange(range) === undefined) {
    fail(
      `${where}.node is "${range}", which this cannot evaluate. heddle carries ` +
        `no semver library, so a node requirement is a single ">=" against a ` +
        `version — ">=22", ">=22.11", ">=22.11.0". Refused here rather than ` +
        `read as satisfied on the machine that runs it.`,
    );
  }
  return { node: range, ...hint };
}

/**
 * A binary requirement's names: one, or several of which any will do.
 *
 * The alternatives are not a convenience. A browser is `chromium` on one
 * machine, `google-chrome` on another and an app bundle path on a Mac, and a
 * requirement that insisted on the first spelling would fail on a machine where
 * the tool works — a preflight that cries wolf is one people learn to skip.
 */
function candidates(raw: unknown, where: string): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    fail(`${where}.binary must name at least one executable`);
  }

  return list.map((entry, i) =>
    text(entry, Array.isArray(raw) ? `${where}.binary[${i}]` : `${where}.binary`),
  );
}

/**
 * Free text for a human, and only that.
 *
 * Checked as a string here so nothing downstream has to wonder what it is
 * holding. It is printed beside the failure it explains — never executed, never
 * passed to a shell, never turned into a command heddle runs. The whole point
 * of a bundle is that opening one does nothing to your machine.
 */
function parseHint(raw: unknown, where: string): { hint?: string } {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.trim() === '') {
    fail(`${where}.hint must be a non-empty string a person can read`);
  }
  refusePlainTextEscapes(raw, `${where}.hint`);
  return { hint: raw.trim() };
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${field} must be a non-empty string`);
  }
  refusePlainTextEscapes(value, field);
  return value.trim();
}

function refusePlainTextEscapes(value: string, field: string): void {
  if (CONTROL_CHARACTERS.test(value)) {
    fail(
      `${field} contains a control character. Everything a requirement says ` +
        `is printed back to a terminal, and an escape sequence inside one ` +
        `could disguise what the report shows.`,
    );
  }
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new BundleError(message);
}
