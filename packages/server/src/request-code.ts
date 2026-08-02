import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkedDest,
  checkedMount,
  messageOf,
  validateManifest,
  withRuntime,
  WorkspaceError,
} from '@heddle/core';
import type { Mount, PluginManifest } from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';

export interface RequestTool {
  name: string;
  source: string;
  interpreter?: string;
}

export interface RequestPlugin {
  name: string;
  manifest: PluginManifest;
  source: string;
}

/** A file the caller wants in the workspace, as the caller's own bytes. */
export interface RequestFile {
  /** Where it lands, relative to the workspace root. Already checked. */
  path: string;
  content: string;
}

export interface MaterializedPlugin {
  name: string;
  /** Already validated, so a refusal can read it without re-walking the raw. */
  manifest: PluginManifest;
  path: string;
}

export interface RequestCode {
  tools?: unknown;
  plugins?: unknown;
  files?: unknown;
}

export interface MaterializedCode {
  toolsDir?: string;
  plugins: MaterializedPlugin[];
  /** Read-only, and one per submitted file. See {@link writeFiles}. */
  mounts: Mount[];
  dispose(): void;
}

export const NO_CODE: MaterializedCode = {
  plugins: [],
  mounts: [],
  dispose: () => {},
};

const INTERPRETERS: Record<string, string> = {
  sh: '#!/bin/sh',
  bash: '#!/usr/bin/env bash',
  python3: '#!/usr/bin/env python3',
  node: '#!/usr/bin/env node',
};

const DEFAULT_INTERPRETER = 'sh';
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SHEBANG = '#!';
const OWNER_READ_EXECUTE = 0o500;
const CODE_FIELDS = ['tools', 'plugins', 'files'];

/** Who asked for these mounts, in a collision message. */
const FILES_ORIGIN = 'the request\'s "files"';

/**
 * A workspace complaint about something the request sent, as a 400.
 *
 * `WorkspaceError` is not a caller-fault type in general, which is why it is on
 * neither list in `errors.ts`: an operator's `--mount` that has gone missing
 * raises the same class and is a 500. It is the caller's fault *here*, and at
 * the one other place a request reaches the workspace layer — layering these
 * mounts onto the server's factory, where the collision is between a path the
 * caller sent and one the operator already claimed.
 */
export function asBadRequest<T>(check: () => T): T {
  try {
    return check();
  } catch (err) {
    if (err instanceof WorkspaceError) {
      throw new HttpError(400, err.message, 'WorkspaceError');
    }
    throw err;
  }
}

export function rejectRequestCode(body: Record<string, unknown>): void {
  for (const field of CODE_FIELDS) {
    if (field in body) {
      throw new HttpError(
        400,
        `"${field}" is not accepted: this server was not started with --allow-request-code`,
      );
    }
  }
}

export function materializeRequestCode(
  body: RequestCode,
  config: ServerConfig,
): MaterializedCode {
  const tools = parseTools(body.tools, config);
  const plugins = parsePlugins(body.plugins, config);
  const files = parseFiles(body.files, config);

  if (tools.length === 0 && plugins.length === 0 && files.length === 0) {
    return NO_CODE;
  }
  // One budget over all three, because they are one thing to the caller: bytes
  // this request asked the server to hold. Splitting it would let a run spend
  // the limit three times.
  assertWithinCodeBudget(
    [
      ...tools.map((tool) => tool.source),
      ...plugins.map((plugin) => plugin.source),
      ...files.map((file) => file.content),
    ],
    config,
  );

  const root = mkdtempSync(join(config.workDir ?? tmpdir(), 'heddle-run-'));
  const dispose = (): void => rmSync(root, { recursive: true, force: true });

  try {
    return {
      toolsDir: tools.length > 0 ? writeTools(root, tools) : undefined,
      plugins: writePlugins(root, plugins),
      mounts: writeFiles(root, files),
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

function writeTools(root: string, tools: RequestTool[]): string {
  const toolsDir = join(root, 'tools');
  mkdirSync(toolsDir);

  for (const tool of tools) {
    writeExecutable(join(toolsDir, tool.name), toolScript(tool));
  }

  return toolsDir;
}

function toolScript(tool: RequestTool): string {
  if (tool.source.startsWith(SHEBANG)) return tool.source;

  const shebang = INTERPRETERS[tool.interpreter ?? DEFAULT_INTERPRETER];
  return `${shebang}\n${tool.source}`;
}

function writePlugins(
  root: string,
  plugins: RequestPlugin[],
): MaterializedPlugin[] {
  if (plugins.length === 0) return [];

  const pluginsDir = join(root, 'plugins');
  mkdirSync(pluginsDir);

  return plugins.map((plugin) => {
    const path = join(pluginsDir, `${plugin.name}.mjs`);
    writeExecutable(
      path,
      `${SHEBANG}${process.execPath}\n${withRuntime(plugin.source)}`,
    );
    return { name: plugin.name, manifest: plugin.manifest, path };
  });
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: OWNER_READ_EXECUTE });
  chmodSync(path, OWNER_READ_EXECUTE);
}

/**
 * The submitted files, on disk and as something a workspace will take.
 *
 * One mount per file rather than one for the directory they share. The caller
 * named these paths one at a time, so a collision should name the path the
 * caller wrote — and grouping them would mount a directory nobody asked for,
 * whose other contents would then be whatever else happened to land there.
 *
 * Written under the run's own temp root, which the run itself never reaches:
 * what a node gets is the workspace's copy, made per scope from these. So this
 * directory is deleted with the rest of the request's code when the run ends,
 * and until then it is a source like any other mount's.
 */
function writeFiles(root: string, files: RequestFile[]): Mount[] {
  if (files.length === 0) return [];

  const filesDir = join(root, 'files');
  mkdirSync(filesDir);

  return files.map((file) => {
    const source = join(filesDir, file.path);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, file.content);

    return asBadRequest(() =>
      checkedMount({
        source,
        dest: file.path,
        mode: 'ro',
        origin: FILES_ORIGIN,
      }),
    );
  });
}

function parseTools(value: unknown, config: ServerConfig): RequestTool[] {
  const seen = new Set<string>();

  return checkArray('tools', value, config.maxRequestTools).map((raw) => {
    const entry = asEntry('tools', raw);
    const name = checkName('tool', entry.name, seen);

    return {
      name,
      source: checkSource('tool', name, entry.source),
      interpreter: checkInterpreter(name, entry.interpreter),
    };
  });
}

function parsePlugins(value: unknown, config: ServerConfig): RequestPlugin[] {
  const seen = new Set<string>();

  return checkArray('plugins', value, config.maxRequestPlugins).map((raw) => {
    const entry = asEntry('plugins', raw);
    const name = checkName('plugin', entry.name, seen);
    const source = checkSource('plugin', name, entry.source);

    if (entry.manifest === undefined) {
      throw new HttpError(400, missingManifestMessage(name));
    }

    return { name, manifest: checkManifest(entry.manifest), source };
  });
}

/**
 * Every submitted file, checked before a byte of it is written.
 *
 * The path is checked the way a `--mount` destination is, by the same function:
 * relative, no climbing, not under `.heddle`. That has to happen here rather
 * than when the mount is made, because the path is where the content is about
 * to be written — a check that ran after the write would be reporting on a file
 * it had already put outside the run's own directory.
 */
function parseFiles(value: unknown, config: ServerConfig): RequestFile[] {
  const seen = new Set<string>();

  return checkArray('files', value, config.maxRequestFiles).map((raw) => {
    const entry = asEntry('files', raw);
    const path = checkPath(entry.path, seen);

    if (typeof entry.content !== 'string') {
      throw new HttpError(
        400,
        `file "${path}" has no "content". A submitted file carries its own ` +
          `bytes — a host path would name a file on the server, which is not ` +
          `yours to read.`,
      );
    }

    return { path, content: entry.content };
  });
}

function checkPath(path: unknown, seen: Set<string>): string {
  if (typeof path !== 'string' || path.trim().length === 0) {
    throw new HttpError(400, `each entry in "files" needs a "path"`);
  }

  const dest = asBadRequest(() =>
    checkedDest({ dest: path, source: path, origin: FILES_ORIGIN }),
  );
  if (seen.has(dest)) {
    throw new HttpError(400, `duplicate file path "${dest}"`);
  }
  seen.add(dest);

  return dest;
}

function assertWithinCodeBudget(
  submitted: string[],
  config: ServerConfig,
): void {
  const total = submitted.reduce(
    (sum, source) => sum + Buffer.byteLength(source, 'utf-8'),
    0,
  );
  if (total <= config.maxRequestCodeBytes) return;

  throw new HttpError(
    400,
    `submitted source totals ${total} bytes, over the ${config.maxRequestCodeBytes} byte limit`,
    'PayloadTooLarge',
  );
}

function checkArray(kind: string, value: unknown, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(400, `"${kind}" must be an array`);
  }
  if (value.length > max) {
    throw new HttpError(400, `at most ${max} ${kind} may be submitted per run`);
  }
  return value;
}

function asEntry(kind: string, raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError(400, `each entry in "${kind}" must be an object`);
  }
  return raw as Record<string, unknown>;
}

function checkName(kind: string, name: unknown, seen: Set<string>): string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new HttpError(
      400,
      `${kind} name must match ${NAME.source} (letters, digits, underscore, hyphen)`,
    );
  }
  if (seen.has(name)) {
    throw new HttpError(400, `duplicate ${kind} name "${name}"`);
  }
  seen.add(name);

  return name;
}

function checkSource(kind: string, name: string, source: unknown): string {
  if (typeof source !== 'string' || source.length === 0) {
    throw new HttpError(400, `${kind} "${name}" has no "source"`);
  }
  return source;
}

function checkInterpreter(name: string, interpreter: unknown): string {
  const chosen = interpreter ?? DEFAULT_INTERPRETER;
  if (typeof chosen !== 'string' || !(chosen in INTERPRETERS)) {
    throw new HttpError(
      400,
      `tool "${name}" has an unsupported interpreter; expected one of ${Object.keys(INTERPRETERS).join(', ')}`,
    );
  }
  return chosen;
}

function checkManifest(manifest: unknown): PluginManifest {
  try {
    return validateManifest(manifest);
  } catch (err) {
    throw new HttpError(400, messageOf(err), 'PluginError');
  }
}

function missingManifestMessage(name: string): string {
  return (
    `plugin "${name}" has no "manifest". Submitted plugins run out of process, ` +
    `so they must declare their component types as data. A module that ` +
    `default-exports a plugin object cannot be accepted here — it would run ` +
    `inside the server.`
  );
}
