import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateManifest, withRuntime } from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';

export interface RequestTool {
  name: string;
  source: string;
  interpreter?: string;
}

export interface RequestPlugin {
  name: string;
  manifest: unknown;
  source: string;
}

export interface MaterializedPlugin {
  name: string;
  manifest: unknown;
  path: string;
}

export interface RequestCode {
  tools?: unknown;
  plugins?: unknown;
}

export interface MaterializedCode {
  toolsDir?: string;
  plugins: MaterializedPlugin[];
  dispose(): void;
}

export const NO_CODE: MaterializedCode = {
  plugins: [],
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
const CODE_FIELDS = ['tools', 'plugins'];

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

  if (tools.length === 0 && plugins.length === 0) return NO_CODE;
  assertWithinCodeBudget([...tools, ...plugins], config);

  const root = mkdtempSync(join(config.workDir ?? tmpdir(), 'heddle-run-'));
  const dispose = (): void => rmSync(root, { recursive: true, force: true });

  try {
    return {
      toolsDir: tools.length > 0 ? writeTools(root, tools) : undefined,
      plugins: writePlugins(root, plugins),
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
    checkManifest(entry.manifest);

    return { name, manifest: entry.manifest, source };
  });
}

function assertWithinCodeBudget(
  submitted: Array<{ source: string }>,
  config: ServerConfig,
): void {
  const total = submitted.reduce(
    (sum, entry) => sum + Buffer.byteLength(entry.source, 'utf-8'),
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

function checkManifest(manifest: unknown): void {
  try {
    validateManifest(manifest);
  } catch (err) {
    throw new HttpError(
      400,
      err instanceof Error ? err.message : String(err),
      'PluginError',
    );
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
