import { linkEntry, usesModuleSyntax } from '../plugin/esm-link.js';
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
  /**
   * Read a sibling module by plugin-dir-relative path, `null` when it is not
   * there. With this, an entry that imports its own files is judged by the
   * same linker a portable host runs it through; without it, any module
   * syntax is refused — the conservative answer for a host that cannot look.
   */
  readFile?: (path: string) => string | null;
}

const SCRIPT_EXTENSIONS = ['.mjs', '.js'];

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
    if (plugin.readFile === undefined) {
      reasons.push(
        `plugin "${name}" imports sibling modules, and this host cannot ` +
          `read them to link`,
      );
    } else {
      const linked = linkEntry({
        source: plugin.entrySource,
        read: plugin.readFile,
      });
      if (!linked.ok) {
        reasons.push(
          ...linked.problems.map(
            (problem) => `plugin "${name}": ${problem}`,
          ),
        );
      }
    }
  }

  return reasons;
}
