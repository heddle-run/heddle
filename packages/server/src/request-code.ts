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
import { validateManifest, withRuntime } from '@heddle/core';
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

/**
 * A plugin submitted with the request.
 *
 * Two halves, and the split is the reason a submitted plugin is safe to accept
 * at all. The `manifest` declares what the plugin provides — component types,
 * inputs, outputs, branches, a schema — as data, so parsing a flow that uses it
 * executes nothing. The `source` is only ever run in a separate process.
 *
 * A submitted plugin is *never* loaded in-process. The old shape, a bare module
 * default-exporting a plugin object, is refused: importing it would run the
 * caller's code inside the server, which is the thing this design exists to
 * prevent.
 */
export interface RequestPlugin {
  name: string;
  /** The plugin's declarative half. Validated before anything is written. */
  manifest: unknown;
  /** Handler source. The runtime is prepended, so it can call `serve()`. */
  source: string;
}

/** A submitted plugin, materialized and ready to load. */
export interface MaterializedPlugin {
  name: string;
  manifest: unknown;
  /** Absolute path of the written module. */
  path: string;
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
    const source = checkSource('plugin', name, entry.source);

    if (entry.manifest === undefined) {
      // The likeliest cause is a plugin written against the in-process API,
      // which this endpoint deliberately cannot accept: loading one means
      // importing it into the server. Say so, rather than reporting a missing
      // field and leaving the author to guess why it is required.
      throw new HttpError(
        400,
        `plugin "${name}" has no "manifest". Submitted plugins run out of process, ` +
          `so they must declare their component types as data. A module that ` +
          `default-exports a plugin object cannot be accepted here — it would run ` +
          `inside the server.`,
      );
    }

    // Validated now, before a byte is written: a bad manifest is a bad request,
    // and there is no reason to create a run directory to discover it.
    try {
      validateManifest(entry.manifest);
    } catch (err) {
      throw new HttpError(
        400,
        err instanceof Error ? err.message : String(err),
        'PluginError',
      );
    }

    return { name, manifest: entry.manifest, source };
  });
}

/** A materialized run directory. Always disposed, whatever the run did. */
export interface MaterializedCode {
  /** Directory of tool executables, or undefined when none were submitted. */
  toolsDir?: string;
  /** Submitted plugins, in submission order. */
  plugins: MaterializedPlugin[];
  dispose(): void;
}

export const NO_CODE: MaterializedCode = {
  plugins: [],
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

    const materializedPlugins: MaterializedPlugin[] = [];
    if (plugins.length > 0) {
      const pluginsDir = join(root, 'plugins');
      mkdirSync(pluginsDir);
      for (const plugin of plugins) {
        // .mjs so node treats it as ESM regardless of any package.json that
        // happens to sit above the temp directory.
        const path = join(pluginsDir, `${plugin.name}.mjs`);
        // Written as a self-contained executable, exactly like a tool, and for
        // the same reason: a sandbox binds the program it is handed and nothing
        // else. Started as `node plugin.mjs` the script would be an argument
        // rather than the program, so it would not exist inside the sandbox.
        //
        // The runtime is prepended rather than imported: the plugin runs from a
        // temp directory with no node_modules beside it, so `serve()` has to
        // arrive in the same file.
        // An absolute interpreter, not `/usr/bin/env node`: a plugin process is
        // given an empty environment, so there is no PATH for `env` to search.
        writeFileSync(path, `#!${process.execPath}\n${withRuntime(plugin.source)}`, {
          mode: 0o500,
        });
        chmodSync(path, 0o500);
        materializedPlugins.push({ name: plugin.name, manifest: plugin.manifest, path });
      }
    }

    return { toolsDir, plugins: materializedPlugins, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}
