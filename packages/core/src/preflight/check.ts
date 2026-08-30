import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { RequirementError } from '../errors.js';
import {
  formatRequirements,
  isPathLike,
  parseNodeRange,
  requirementLabel,
  shortName,
  type BinaryRequirement,
  type CheckedRequirement,
  type EnvRequirement,
  type FileRequirement,
  type NodeRequirement,
  type Requirement,
  type Unmet,
} from './parse.js';

/**
 * The check half of preflight: every predicate is a pure observation of this
 * machine — read `process.env`, look on `$PATH`, `stat` a path, compare a
 * version. Nothing here writes, downloads, or spawns anything, and there is
 * deliberately no predicate that could. A `.heddle` file can be downloaded
 * from anywhere, and the format's whole premise is that opening one runs
 * nothing — a requirement that executed a declared command would be remote
 * code execution wearing a preflight's clothes. Installing what is missing is
 * the operator's move, with their package manager, after reading what this
 * printed. (The CLI can make some of those moves for them — see its
 * `install-recipes.ts` — but every command it offers comes from its own
 * reviewed table, never from the declaration; a requirement still only
 * selects, and this module still only looks.)
 */

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
    const found = isPathLike(candidate)
      ? isExecutableFile(candidate) && candidate
      : onPath(candidate, env);

    if (found) return { requirement, label, found: shortName(found) };
  }

  return {
    requirement,
    label,
    // "not on PATH" would be the wrong instruction for a requirement that named
    // only absolute paths — nothing about `$PATH` would satisfy it.
    reason: requirement.binary.every(isPathLike) ? 'not found' : 'not on PATH',
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
 * supported is what `parseNodeRange` matches — and a range outside it is
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
