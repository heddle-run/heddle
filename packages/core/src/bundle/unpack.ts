import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { BundleError } from '../errors.js';
import {
  BUNDLE_MANIFEST,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_ENTRIES,
  validateBundleManifest,
  type BundleManifest,
} from './format.js';
import { readTarGz, type TarEntry } from './tar.js';

/**
 * Extract a `.heddle` archive into `destDir` and hand back its manifest.
 *
 * The manifest is read and validated *before* anything touches the disk: a
 * bundle whose manifest is missing or malformed writes nothing, so a refusal
 * leaves no half-extracted directory to clean up or to trust by accident.
 *
 * Every entry's path is checked against the extraction directory. The archive
 * came from somebody else — that is the point of a bundle — so a name that
 * climbs, an absolute name, or a link (refused in the tar reader) is treated
 * as an attack, not a defect.
 */
export function extractBundle(
  archivePath: string,
  destDir: string,
): BundleManifest {
  let archive: Buffer;
  try {
    archive = readFileSync(archivePath);
  } catch (err) {
    throw new BundleError(`cannot read bundle "${archivePath}"`, { cause: err });
  }

  const entries = readTarGz(archive, {
    maxBytes: MAX_BUNDLE_BYTES,
    maxEntries: MAX_BUNDLE_ENTRIES,
  });

  const manifest = manifestOf(entries, archivePath);

  for (const entry of entries) {
    const target = join(destDir, safeName(entry.name));

    if (entry.data === undefined) {
      mkdirSync(target, { recursive: true });
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    // Only the one bit that means anything travels: a tool is a tool because
    // it is executable. Everything else lands owner-writable and private.
    writeFileSync(target, entry.data, {
      mode: entry.executable ? 0o755 : 0o644,
    });
  }

  assertComplete(manifest, destDir, archivePath);
  return manifest;
}

function manifestOf(entries: TarEntry[], archivePath: string): BundleManifest {
  const entry = entries.find((candidate) => candidate.name === BUNDLE_MANIFEST);
  if (entry?.data === undefined) {
    throw new BundleError(
      `"${archivePath}" has no ${BUNDLE_MANIFEST} at its root, so it is a tar ` +
        `archive but not a heddle bundle. One is written by "heddle bundle".`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(entry.data.toString('utf-8'));
  } catch (err) {
    throw new BundleError(`"${archivePath}": ${BUNDLE_MANIFEST} is not JSON`, {
      cause: err,
    });
  }
  return validateBundleManifest(raw);
}

/**
 * An entry name that may be joined to the extraction directory.
 *
 * The same shape `archivePath` enforces on manifest fields, applied to what
 * the archive itself says. Both exist because they guard different inputs: a
 * manifest can name a clean path in an archive full of dirty ones.
 */
function safeName(name: string): string {
  if (name.length === 0) {
    throw new BundleError('bundle has an entry with an empty name');
  }
  if (name.startsWith('/') || name.includes('\\')) {
    throw new BundleError(
      `bundle entry "${name}" is not a relative '/' path, so it would land ` +
        `outside the extraction directory.`,
    );
  }
  const segments = name.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..')) {
    throw new BundleError(
      `bundle entry "${name}" steps outside the extraction directory.`,
    );
  }
  return segments.join(sep);
}

/**
 * Everything the manifest names must have been in the archive.
 *
 * Checked after extraction rather than trusted, because the manifest and the
 * entries are written by the same author but read by different code: a bundle
 * whose manifest promises a flow the archive does not carry would otherwise
 * surface later as ENOENT from `loadFlow`, blaming a temp path the operator
 * never typed.
 */
function assertComplete(
  manifest: BundleManifest,
  destDir: string,
  archivePath: string,
): void {
  const missing = [
    manifest.flow,
    ...(manifest.tools === undefined ? [] : [manifest.tools]),
    ...manifest.plugins,
    ...manifest.mounts.map((mount) => mount.path),
  ].filter((path) => !existsSync(join(destDir, ...path.split('/'))));

  if (missing.length > 0) {
    throw new BundleError(
      `"${archivePath}" names ${missing.map((path) => `"${path}"`).join(', ')} ` +
        `in its ${BUNDLE_MANIFEST} but does not carry ${missing.length === 1 ? 'it' : 'them'}. ` +
        `The bundle is incomplete — rebuild it with "heddle bundle".`,
    );
  }
}
