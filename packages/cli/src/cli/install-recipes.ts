import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inspectRequirements, type Requirement, type Unmet } from '@heddle-run/core';

/** What matching needs from an unmet check; `Unmet` and friends both fit. */
type UnmetShape = Pick<Unmet, 'requirement' | 'label'>;

/**
 * The installs heddle knows how to make itself, keyed by what a requirement
 * is missing.
 *
 * The rule that kept the preflight from becoming remote code execution still
 * holds, drawn one line further out: nothing a bundle carries is ever
 * executed, downloaded from, or written to. A `.heddle` file can be
 * downloaded from anywhere, so a requirement only *selects* an entry from
 * this table — every command, URL and destination path below is heddle's own,
 * versioned with the CLI and reviewed like the rest of it. A bundle that
 * declares `binary: ["whisper-cli"]` gets the same `brew install whisper-cpp`
 * whoever wrote it, and a `file` requirement is only matched when it names
 * exactly the destination the table already writes to — a declaration cannot
 * steer a download anywhere else. Hints stay display-only, as ever.
 *
 * Nothing runs without the operator seeing the exact commands and answering
 * yes at a terminal; off a terminal this module is never consulted.
 */

/** A package-manager command, run without a shell, output on the terminal. */
export interface CommandRecipe {
  kind: 'command';
  /** What runs — argv[0] resolved on PATH, no shell in between. */
  argv: string[];
}

/** An HTTPS fetch of a known file into a heddle-owned path. */
export interface DownloadRecipe {
  kind: 'download';
  url: string;
  /** Absolute destination; always under ~/.heddle. */
  to: string;
  /** Shown in the offer, so nobody consents to 148 MB by surprise. */
  size: string;
}

export type InstallRecipe = (CommandRecipe | DownloadRecipe) & {
  /** The requirement it satisfies, as the report labeled it. */
  label: string;
};

/** Binaries heddle will install, and the Homebrew package that carries each. */
const BREW_PACKAGES: Record<string, string> = {
  'whisper-cli': 'whisper-cpp',
  ffmpeg: 'ffmpeg',
};

/** Where downloaded models live — beside ~/.heddle/sessions. */
const MODELS_DIR = join(homedir(), '.heddle', 'models');

/**
 * Model files heddle will download, by basename. `to` is the only path the
 * download can write; a requirement matches only by naming it exactly.
 */
const MODEL_DOWNLOADS: Record<string, DownloadRecipe> = {
  'ggml-base.en.bin': {
    kind: 'download',
    url: 'https://huggingface.co/ggml-org/whisper.cpp/resolve/main/ggml-base.en.bin',
    to: join(MODELS_DIR, 'ggml-base.en.bin'),
    size: '~148 MB',
  },
  'ggml-silero-v5.1.2.bin': {
    kind: 'download',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin',
    to: join(MODELS_DIR, 'ggml-silero-v5.1.2.bin'),
    size: '~1 MB',
  },
};

/**
 * The recipes that would satisfy these unmet requirements, in declaration
 * order. Empty when heddle knows no fix — the manual pause is the answer then,
 * same as before recipes existed.
 *
 * Command recipes are only offered where Homebrew is present (macOS, or a
 * linuxbrew): offering a command that cannot run is worse than the hint.
 * Downloads need only the network, so they are offered everywhere.
 */
export function installRecipes(
  unmet: UnmetShape[],
  env: NodeJS.ProcessEnv,
): InstallRecipe[] {
  const brew = hasBrew(env);
  const recipes: InstallRecipe[] = [];

  for (const { requirement, label } of unmet) {
    if ('binary' in requirement && brew) {
      const pkg = requirement.binary.map((name) => BREW_PACKAGES[basename(name)]).find(Boolean);
      if (pkg) recipes.push({ kind: 'command', argv: ['brew', 'install', pkg], label });
    }
    if ('file' in requirement) {
      const known = MODEL_DOWNLOADS[basename(requirement.file)];
      // Matched on the whole path, not the basename: the bundle must mean the
      // file the table writes, or the download stays unoffered.
      if (known && expandHome(requirement.file) === known.to) {
        recipes.push({ ...known, label });
      }
    }
  }
  return recipes;
}

/** One line per recipe, exactly what saying yes agrees to. */
export function describeRecipe(recipe: InstallRecipe): string {
  return recipe.kind === 'command'
    ? recipe.argv.join(' ')
    : `download ${recipe.url} → ${recipe.to} (${recipe.size})`;
}

/**
 * Run one recipe. A command inherits the terminal so brew's own output and
 * prompts land where the operator is already looking; a download streams to a
 * temp name and renames, so a half-fetched model never passes the file check.
 */
export async function executeRecipe(recipe: InstallRecipe): Promise<void> {
  if (recipe.kind === 'command') {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(recipe.argv[0], recipe.argv.slice(1), { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`${recipe.argv.join(' ')} exited with ${code}`)),
      );
    });
    return;
  }

  const reply = await fetch(recipe.url, { redirect: 'follow' });
  if (!reply.ok || reply.body === null) {
    throw new Error(`${recipe.url} answered ${reply.status}`);
  }

  mkdirSync(dirname(recipe.to), { recursive: true });
  const partial = `${recipe.to}.download`;
  try {
    await pipeline(Readable.fromWeb(reply.body as never), createWriteStream(partial));
    renameSync(partial, recipe.to);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
}

function hasBrew(env: NodeJS.ProcessEnv): boolean {
  // Core's PATH walk, reused rather than re-implemented, so "is brew here"
  // and "is whisper-cli here" can never disagree about what PATH means.
  return inspectRequirements([{ binary: ['brew'] } as Requirement], env).every(
    (check) => check.reason === undefined,
  );
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
