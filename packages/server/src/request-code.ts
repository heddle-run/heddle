/**
 * Materializing tool scripts and plugin modules submitted with a request.
 *
 * Only reachable when the server was started with `allowRequestCode`. Read the
 * note on that option before enabling it: tool scripts become subprocesses and
 * can be confined by a sandbox, but plugin modules are loaded with a dynamic
 * `import()` and run inside this Node process, with its environment and its
 * filesystem access. Nothing in this file confines them, and nothing in this
 * package can. The boundary has to be the process itself — one disposable
 * container per run.
 *
 * What this file is responsible for is narrower: getting submitted source onto
 * disk without letting a name decide where it lands, and taking it away again.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';

/** A tool script submitted with the request. */
export interface RequestTool {
  /** Tool name as the flow refers to it. Becomes the filename. */
  name: string;
  source: string;
  /** Shebang to generate when the source has none. Defaults to `sh`. */
  interpreter?: string;
}

/** A plugin module submitted with the request. ESM, default-exporting a plugin. */
export interface RequestPlugin {
  name: string;
  source: string;
}

export interface RequestCode {
  tools?: unknown;
  plugins?: unknown;
}

/**
 * Interpreters a submitted tool may ask for.
 *
 * An allowlist rather than a free string: the value is written into a shebang
 * line, where an arbitrary string would let a caller choose the argv of the
 * process that runs its script. A caller wanting something else can write its
 * own shebang as the first line of `source`, which is passed through untouched.
 */
const INTERPRETERS: Record<string, string> = {
  sh: '#!/bin/sh',
  bash: '#!/usr/bin/env bash',
  python3: '#!/usr/bin/env python3',
  node: '#!/usr/bin/env node',
};

/**
 * Names are filenames, so they may not contain anything that navigates. This
 * excludes `/`, `\`, `.` and every control character, which leaves no way to
 * address a path outside the directory the file is written into.
 */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

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

function parseTools(value: unknown, config: ServerConfig): RequestTool[] {
  const seen = new Set<string>();
  return checkArray('tools', value, config.maxRequestTools).map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new HttpError(400, 'each entry in "tools" must be an object');
    }
    const entry = raw as Record<string, unknown>;
    const name = checkName('tool', entry.name, seen);
    const source = checkSource('tool', name, entry.source);

    const interpreter = entry.interpreter ?? 'sh';
    if (typeof interpreter !== 'string' || !(interpreter in INTERPRETERS)) {
      throw new HttpError(
        400,
        `tool "${name}" has an unsupported interpreter; expected one of ${Object.keys(INTERPRETERS).join(', ')}`,
      );
    }

    return { name, source, interpreter };
  });
}

function parsePlugins(value: unknown, config: ServerConfig): RequestPlugin[] {
  const seen = new Set<string>();
  return checkArray('plugins', value, config.maxRequestPlugins).map((raw) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new HttpError(400, 'each entry in "plugins" must be an object');
    }
    const entry = raw as Record<string, unknown>;
    const name = checkName('plugin', entry.name, seen);
    return { name, source: checkSource('plugin', name, entry.source) };
  });
}

/** A materialized run directory. Always disposed, whatever the run did. */
export interface MaterializedCode {
  /** Directory of tool executables, or undefined when none were submitted. */
  toolsDir?: string;
  /** Absolute paths of plugin modules, in submission order. */
  pluginPaths: string[];
  dispose(): void;
}

export const NO_CODE: MaterializedCode = {
  pluginPaths: [],
  dispose: () => {},
};

/**
 * Reject submitted code on a server that does not accept it.
 *
 * Refused rather than ignored, on the same reasoning as the tools-directory
 * check: a caller whose plugin was silently dropped would watch its flow fail
 * with an unknown component type and have no way to learn why.
 */
export function rejectRequestCode(body: Record<string, unknown>): void {
  for (const field of ['tools', 'plugins']) {
    if (field in body) {
      throw new HttpError(
        400,
        `"${field}" is not accepted: this server was not started with --allow-request-code`,
      );
    }
  }
}

/**
 * Write submitted tools and plugins into a fresh directory under the system
 * temp root. The directory is created by `mkdtemp`, so runs never share one and
 * a name collision between concurrent requests is not possible.
 */
export function materializeRequestCode(
  body: RequestCode,
  config: ServerConfig,
): MaterializedCode {
  const tools = parseTools(body.tools, config);
  const plugins = parsePlugins(body.plugins, config);

  if (tools.length === 0 && plugins.length === 0) return NO_CODE;

  const total = [...tools, ...plugins].reduce(
    (sum, entry) => sum + Buffer.byteLength(entry.source, 'utf-8'),
    0,
  );
  if (total > config.maxRequestCodeBytes) {
    throw new HttpError(
      400,
      `submitted source totals ${total} bytes, over the ${config.maxRequestCodeBytes} byte limit`,
      'PayloadTooLarge',
    );
  }

  const root = mkdtempSync(join(config.workDir ?? tmpdir(), 'heddle-run-'));
  const dispose = () => rmSync(root, { recursive: true, force: true });

  try {
    let toolsDir: string | undefined;
    if (tools.length > 0) {
      toolsDir = join(root, 'tools');
      mkdirSync(toolsDir);
      for (const tool of tools) {
        const script = tool.source.startsWith('#!')
          ? tool.source
          : `${INTERPRETERS[tool.interpreter ?? 'sh']}\n${tool.source}`;
        const path = join(toolsDir, tool.name);
        writeFileSync(path, script, { mode: 0o500 });
        // Explicit chmod: writeFileSync's mode is masked by the process umask,
        // and a tool that is not executable is not discovered by FileRegistry.
        chmodSync(path, 0o500);
      }
    }

    const pluginPaths: string[] = [];
    if (plugins.length > 0) {
      const pluginsDir = join(root, 'plugins');
      mkdirSync(pluginsDir);
      for (const plugin of plugins) {
        // .mjs so node treats it as ESM regardless of any package.json that
        // happens to sit above the temp directory.
        const path = join(pluginsDir, `${plugin.name}.mjs`);
        writeFileSync(path, plugin.source, { mode: 0o400 });
        pluginPaths.push(path);
      }
    }

    return { toolsDir, pluginPaths, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}
