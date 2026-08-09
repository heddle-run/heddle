import { BundleError } from '../errors.js';
import { parseRequirements, type Requirement } from '../preflight.js';
import type { MountMode } from '../workspace/types.js';

/**
 * What a `.heddle` file is: a gzipped tar with a `heddle.json` at its root.
 *
 * The manifest names everything else in the archive by path, so opening a
 * bundle is reading one file — the archive's layout is data, not convention.
 * Everything here is declarative and machine-relative-free on purpose: a
 * bundle built on one machine names nothing that exists only there, which is
 * the whole reason it can be handed to somebody else.
 *
 * What a bundle deliberately does *not* carry: sandbox policy, session
 * bindings, and discovery grants. Each of those is the operator's decision
 * about their own machine, and a file that arrived in the mail does not get to
 * make it.
 */

export const BUNDLE_EXTENSION = '.heddle';
export const BUNDLE_MANIFEST = 'heddle.json';
export const BUNDLE_FORMAT = 1;

/**
 * How big a bundle may unpack to. Wider than a single `--mount`'s budget
 * because a bundle aggregates several inputs — but still a hard edge, because
 * the reader inflates this before it can judge any of it.
 */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
export const MAX_BUNDLE_ENTRIES = 32768;

export interface BundleMount {
  /** Where the mounted tree lives inside the archive. */
  path: string;
  /** Where it lands in every workspace, relative to the workspace root. */
  dest: string;
  mode: MountMode;
}

export interface BundleManifest {
  format: number;
  /** The flow's name, for display — the flow file is the authority. */
  name: string;
  /** Archive path of the flow spec (JSON or YAML). */
  flow: string;
  /** Archive path of the tools directory, when the bundle ships tools. */
  tools?: string;
  /** Archive paths of plugin manifests, each inside its plugin's directory. */
  plugins: string[];
  /** Component settings, resolved at pack time — `@file` never travels. */
  pluginConfig: Record<string, Record<string, unknown>>;
  mounts: BundleMount[];
  /** Default `--input`, overridable at run time. */
  input?: Record<string, unknown>;
  /**
   * The bundle would rather open a conversation than run once.
   *
   * A proposal, exactly like `input`: `heddle run` honours it only at a real
   * terminal with nothing overriding it — an explicit `--input`, an encoder,
   * a resume — and everything else runs the recorded input once, so scripts
   * and CI never block on a UI. Like `requires`, the field arrived without a
   * format bump: an older heddle ignores it and behaves as it always did.
   */
  interactive?: boolean;
  /**
   * What the machine running this has to already have — checked before a run
   * starts, never acted on. A declaration, like everything else here: heddle
   * looks, reports what is missing, and installs nothing.
   */
  requires?: Requirement[];
}

export function isBundlePath(path: string): boolean {
  return path.endsWith(BUNDLE_EXTENSION);
}

export function validateBundleManifest(raw: unknown): BundleManifest {
  const manifest = asObject(raw, `${BUNDLE_MANIFEST} must be a JSON object`);

  const format = manifest.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    fail(`${BUNDLE_MANIFEST} has no usable "format" number`);
  }
  if (format > BUNDLE_FORMAT) {
    fail(
      `this bundle is format ${format} and this heddle reads up to ` +
        `${BUNDLE_FORMAT}. It was made by a newer heddle — upgrade to run it.`,
    );
  }

  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    fail(`${BUNDLE_MANIFEST} is missing a "name"`);
  }

  return {
    format,
    name: manifest.name,
    flow: archivePath(manifest.flow, 'flow'),
    tools:
      manifest.tools === undefined
        ? undefined
        : archivePath(manifest.tools, 'tools'),
    plugins: asPlugins(manifest.plugins),
    pluginConfig: asPluginConfig(manifest.pluginConfig),
    mounts: asMounts(manifest.mounts),
    input: asOptionalObject(manifest.input, 'input'),
    interactive: manifest.interactive === true ? true : undefined,
    // `requires` arrived after format 1 and did *not* bump it, deliberately.
    // Everything above reads the fields it knows and ignores the rest, so an
    // older heddle opening a bundle that declares requirements skips the check
    // and behaves exactly as it did before the field existed. A version bump
    // would instead make it refuse the file outright — trading a check it
    // cannot perform for a bundle it cannot run, which is the worse half of
    // the deal for the person holding the file.
    requires: asRequires(manifest.requires),
  };
}

/**
 * A path the manifest may use to name something in the archive.
 *
 * Checked at read time even though the packer only writes clean ones, because
 * the manifest is the one part of a bundle that is followed rather than merely
 * copied: a "flow" of `../../etc/anything` would be joined to the extraction
 * directory and read.
 */
function archivePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${BUNDLE_MANIFEST} "${field}" must be a non-empty path`);
  }
  if (value.startsWith('/') || value.includes('\\')) {
    fail(`${BUNDLE_MANIFEST} "${field}" ("${value}") must be a relative '/' path`);
  }
  const segments = value.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    fail(
      `${BUNDLE_MANIFEST} "${field}" ("${value}") steps outside the bundle. A ` +
        `manifest path is followed after extraction, so one that climbs is an ` +
        `escape rather than a typo.`,
    );
  }
  return value;
}

function asPlugins(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail(`${BUNDLE_MANIFEST} "plugins" must be an array of paths`);
  }
  return raw.map((entry, i) => archivePath(entry, `plugins[${i}]`));
}

function asPluginConfig(
  raw: unknown,
): Record<string, Record<string, unknown>> {
  if (raw === undefined) return {};
  const config = asObject(raw, `${BUNDLE_MANIFEST} "pluginConfig" must be an object`);

  for (const [componentType, settings] of Object.entries(config)) {
    asObject(
      settings,
      `${BUNDLE_MANIFEST} pluginConfig["${componentType}"] must be an object of settings`,
    );
  }
  return config as Record<string, Record<string, unknown>>;
}

function asMounts(raw: unknown): BundleMount[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    fail(`${BUNDLE_MANIFEST} "mounts" must be an array`);
  }

  return raw.map((entry, i) => {
    const mount = asObject(entry, `${BUNDLE_MANIFEST} mounts[${i}] must be an object`);
    const mode = mount.mode ?? 'ro';
    if (mode !== 'ro' && mode !== 'rw') {
      fail(`${BUNDLE_MANIFEST} mounts[${i}] has mode "${String(mode)}"; expected ro or rw`);
    }
    if (typeof mount.dest !== 'string' || mount.dest.length === 0) {
      fail(`${BUNDLE_MANIFEST} mounts[${i}] is missing a "dest"`);
    }
    return {
      path: archivePath(mount.path, `mounts[${i}].path`),
      // Not checked here beyond its presence: `checkedDest` owns the rules for
      // where a mount may land, and the opener applies it before anything is
      // copied. Two validators for one rule would drift.
      dest: mount.dest,
      mode,
    };
  });
}

/**
 * The requirements, through the one reader that understands the declaration.
 *
 * `parseRequirements` throws a `BundleError` of its own naming the offending
 * entry, which is what belongs in a manifest message, so nothing is caught and
 * rephrased here. A bundle with an unreadable `requires` is refused rather than
 * opened with the check quietly skipped: a declaration nobody evaluates is the
 * state this whole field exists to end.
 */
function asRequires(raw: unknown): Requirement[] | undefined {
  if (raw === undefined) return undefined;

  const requires = parseRequirements(raw);
  return requires.length > 0 ? requires : undefined;
}

function asOptionalObject(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return asObject(value, `${BUNDLE_MANIFEST} "${field}" must be a JSON object`);
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(message);
  }
  return value as Record<string, unknown>;
}

function fail(message: string): never {
  throw new BundleError(message);
}
