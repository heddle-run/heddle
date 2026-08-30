import type { PluginManifest } from '../plugin/manifest.js';
import type { Requirement } from '../preflight/parse.js';
import type { BundleManifest } from './format.js';

/**
 * Whether a bundle can run without starting a process.
 *
 * "Portable" here means: everything the bundle ships is data plus JavaScript a
 * host can evaluate in its own context — no executables, no interpreters, no
 * filesystem conventions. That is the shape an iOS app can run, and the shape
 * this check exists to recognise. The rules are conservative on purpose: a
 * false "no" costs a fallback to a machine with processes, while a false "yes"
 * costs a run that fails somewhere worse than here.
 *
 * This is the definition of record. The Swift mirror in the apps applies the
 * same rules to the same fields; when they disagree, this one is right.
 */
export interface PortabilityReport {
  portable: boolean;
  /** Why not, one plain sentence per blocker. Empty when portable. */
  reasons: string[];
}

export interface PortablePluginInput {
  manifest: PluginManifest;
  /** The resolved entry filename, when the host resolved one. */
  entry?: string;
  /** The entry's source text, when the host read it. */
  entrySource?: string;
}

const SCRIPT_EXTENSIONS = ['.mjs', '.js'];

/**
 * Top-level ESM syntax the classic-script evaluation a portable host uses
 * cannot link. Scanned per line rather than parsed: a false positive only
 * sends the bundle to a host with a module loader, never runs it wrong.
 */
const MODULE_SYNTAX = /^\s*(import[\s"'{*]|export\s+.*\bfrom\b)/;

export function checkPortability(
  manifest: BundleManifest,
  plugins: PortablePluginInput[],
): PortabilityReport {
  const reasons: string[] = [];

  if (manifest.tools !== undefined) {
    reasons.push(
      'it ships a tools directory — tools are programs, and a portable host ' +
        'starts no processes',
    );
  }
  if (manifest.mounts.length > 0) {
    reasons.push(
      'it declares mounts, which land in the workspaces of tool processes a ' +
        'portable host does not have',
    );
  }
  for (const requirement of manifest.requires ?? []) {
    const wants = requirementWords(requirement);
    if (wants === undefined) continue;
    reasons.push(`it requires ${wants} — a portable host has none to offer`);
  }

  for (const plugin of plugins) {
    reasons.push(...pluginReasons(plugin));
  }

  return { portable: reasons.length === 0, reasons };
}

/** What an unportable requirement asks for — or nothing, for one a host meets. */
function requirementWords(requirement: Requirement): string | undefined {
  if ('env' in requirement) return undefined;
  if ('binary' in requirement) return 'a program on PATH';
  if ('node' in requirement) return 'a Node.js runtime';
  return 'a file on this machine';
}

function pluginReasons(plugin: PortablePluginInput): string[] {
  const name = plugin.manifest.name;
  const reasons: string[] = [];

  if (plugin.manifest.command) {
    reasons.push(
      `plugin "${name}" launches its own command — a process a portable ` +
        `host cannot start`,
    );
  }
  if (plugin.manifest.discoverTools) {
    reasons.push(
      `plugin "${name}" discovers its tools at start, which means starting it`,
    );
  }
  if (plugin.manifest.files.length > 0) {
    reasons.push(
      `plugin "${name}" ships workspace files, which land beside tool ` +
        `processes a portable host does not have`,
    );
  }
  for (const tool of plugin.manifest.tools) {
    if (tool.path !== undefined) {
      reasons.push(
        `plugin "${name}" tool "${tool.name}" is an executable program`,
      );
    }
  }

  if (
    plugin.entry !== undefined &&
    !SCRIPT_EXTENSIONS.some((extension) => plugin.entry?.endsWith(extension))
  ) {
    reasons.push(
      `plugin "${name}" has an entry that is not a .mjs/.js file, so only ` +
        `its own interpreter can run it`,
    );
  }
  if (plugin.entrySource !== undefined && usesModuleSyntax(plugin.entrySource)) {
    reasons.push(
      `plugin "${name}" imports sibling modules, which a portable host ` +
        `cannot link yet`,
    );
  }

  return reasons;
}

function usesModuleSyntax(source: string): boolean {
  return source.split('\n').some((line) => MODULE_SYNTAX.test(line));
}
