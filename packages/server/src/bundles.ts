import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundlePortability,
  extractBundle,
  openBundle,
  resolveExtractedBundle,
  validateBundleManifest,
  BUNDLE_MANIFEST,
  type OpenedBundle,
} from '@heddle-run/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';
import { readRawBody, sendJson } from './http.js';

/**
 * Bundles over HTTP, and the one rule that is not the CLI's.
 *
 * **A bundle runs with this server's full rights.** Its plugins are processes,
 * its tools are executables, its mounts land in every workspace — none of the
 * request-code refusals apply, because a bundle is not request code. It is the
 * operator's trust decision made portable: whoever can reach this server can
 * hand it a program, so a deployment that should execute only
 * operator-installed code runs `--no-bundles` and every route here refuses.
 *
 * The store is content-addressed: an id is the sha-256 of the archive's bytes,
 * so uploading the same bundle twice yields the same id and stores one copy.
 * There is no list endpoint and no eviction — an id is only learned from the
 * upload that minted it, DELETE exists, and the default directory is under the
 * OS temp dir. What is kept and for how long is the operator's business.
 */

/** An id as `save` mints them: the archive's sha-256, in lowercase hex. */
const BUNDLE_ID = /^[0-9a-f]{64}$/;

/** What one saved archive becomes on disk, inside `<root>/<id>/`. */
const ARCHIVE_NAME = 'bundle.heddle';

export class BundleStore {
  constructor(private readonly root: string) {}

  /**
   * Extract the archive into the store under its content id.
   *
   * Extraction happens in a staging directory and the result is renamed into
   * place, so a concurrent upload of the same bytes and a crash mid-extract
   * both leave either a complete bundle or none — never a directory that
   * looks like one. Idempotent by construction: the id *is* the bytes, so an
   * id that already exists is the same bundle already saved.
   */
  save(bytes: Buffer): { id: string; existed: boolean } {
    const id = createHash('sha256').update(bytes).digest('hex');
    const dir = join(this.root, id);
    if (existsSync(dir)) return { id, existed: true };

    mkdirSync(this.root, { recursive: true });
    const staging = mkdtempSync(join(this.root, 'incoming-'));
    try {
      const archive = join(staging, ARCHIVE_NAME);
      writeFileSync(archive, bytes);

      const extracted = join(staging, 'extracted');
      mkdirSync(extracted);
      extractBundle(archive, extracted);

      try {
        renameSync(extracted, dir);
      } catch (err) {
        // Lost the race to another upload of the same bytes, which by
        // definition put the same content there. Anything else is real.
        if (!existsSync(dir)) throw err;
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }

    return { id, existed: false };
  }

  /**
   * Resolve a stored bundle for a run, or nothing for an id never saved.
   *
   * Re-read through `validateBundleManifest` even though `save` validated it,
   * because the manifest on disk is the one being followed — the store
   * outlives this process, and a rule tightened between then and now should
   * apply to what runs now. `dispose` is a no-op: the directory is the
   * store's, not the run's.
   */
  open(id: string): OpenedBundle | undefined {
    const dir = join(this.root, id);

    let raw: string;
    try {
      raw = readFileSync(join(dir, BUNDLE_MANIFEST), 'utf-8');
    } catch {
      return undefined;
    }

    const manifest = validateBundleManifest(JSON.parse(raw));
    return resolveExtractedBundle(manifest, dir, { origin: `bundle ${id}` });
  }

  delete(id: string): void {
    rmSync(join(this.root, id), { recursive: true, force: true });
  }
}

export async function handleUploadBundle(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  headers: Record<string, string>,
): Promise<void> {
  assertBundlesEnabled(config);

  // The bytes as sent, whatever the content type says — an archive is judged
  // by its magic numbers, and gating on a header would only refuse uploads
  // from clients that never thought to set one.
  const bytes = await readRawBody(req, config.maxBundleBytes);
  if (bytes.length === 0) {
    throw new HttpError(
      400,
      'request body is empty; send the bytes of a .heddle archive',
    );
  }

  const store = new BundleStore(config.bundlesDir);
  const { id, existed } = store.save(bytes);
  const bundle = store.open(id);
  if (!bundle) {
    throw new HttpError(500, `bundle "${id}" vanished after saving`, 'StoreError');
  }

  // 200 rather than 201 for bytes already held: nothing was created, and the
  // caller learns the more useful fact — this id was already good to run.
  sendJson(res, existed ? 200 : 201, bundleSummary(id, bundle), headers);
}

export function handleReadBundle(
  res: ServerResponse,
  config: ServerConfig,
  rawId: string,
  headers: Record<string, string>,
): void {
  assertBundlesEnabled(config);
  const id = validBundleId(rawId);

  const bundle = new BundleStore(config.bundlesDir).open(id);
  if (!bundle) throw new HttpError(404, unknownBundleMessage(id), 'NoSuchBundle');

  sendJson(res, 200, bundleSummary(id, bundle), headers);
}

export function handleDeleteBundle(
  res: ServerResponse,
  config: ServerConfig,
  rawId: string,
  headers: Record<string, string>,
): void {
  assertBundlesEnabled(config);
  const id = validBundleId(rawId);

  new BundleStore(config.bundlesDir).delete(id);
  sendJson(res, 200, { id, deleted: true }, headers);
}

/**
 * What a caller is told about a bundle, at upload and on GET.
 *
 * The manifest's proposals — default input, the wish for a conversation, the
 * machine's obligations — plus the portability verdict, which is the field the
 * iOS app uploads a bundle to learn: `portable` says whether this bundle could
 * have run on a host that starts no processes, and `reasons` say why not.
 */
function bundleSummary(
  id: string,
  bundle: OpenedBundle,
): Record<string, unknown> {
  const report = bundlePortability(bundle);

  return {
    id,
    name: bundle.name,
    input: bundle.input,
    interactive: bundle.interactive,
    session: bundle.session,
    requires: bundle.requires,
    portable: report.portable,
    ...(report.portable ? {} : { reasons: report.reasons }),
  };
}

/** The fields of a run request that name a bundle, in refusal order. */
const BUNDLE_FIELDS = ['bundle', 'bundleData'] as const;

/** What a bundle already carries, so a request may not also send it. */
const CARRIED_FIELDS = [
  'flow',
  'flowPath',
  'format',
  'tools',
  'plugins',
  'files',
];

/**
 * Refuse a run body whose bundle fields cannot mean one thing.
 *
 * Before anything is materialized, so the refusal names the collision rather
 * than surfacing as whichever half happened to be read first. A bundle carries
 * its own flow, tools and plugins — a request sending both is asking for two
 * runs at once, and heddle will not guess which one was meant.
 */
export function rejectBundleConflicts(
  body: Record<string, unknown>,
  config: ServerConfig,
): void {
  const named = BUNDLE_FIELDS.filter((field) => field in body);
  if (named.length === 0) return;

  if (!config.bundles) {
    throw new HttpError(
      400,
      `"${named[0]}" is not accepted: this server was started with --no-bundles`,
    );
  }
  if (named.length === 2) {
    throw new HttpError(400, 'provide either "bundle" or "bundleData", not both');
  }
  for (const field of CARRIED_FIELDS) {
    if (field in body) {
      throw new HttpError(
        400,
        `"${field}" cannot be sent with "${named[0]}": a bundle already ` +
          `carries its flow, tools and plugins`,
      );
    }
  }
}

/**
 * The bundle a run body named, opened — or nothing, for a run without one.
 *
 * Two shapes with one meaning. A stored id resolves against the store and is
 * the store's directory, disposed by nobody. Inline bytes are one-shot: they
 * are written and extracted under the run's temp root and the handle's
 * `dispose` removes all of it, so nothing a request carried outlives the run
 * that carried it.
 */
export function materializeBundle(
  body: { bundle?: unknown; bundleData?: unknown },
  config: ServerConfig,
): OpenedBundle | undefined {
  if (body.bundle !== undefined) {
    if (typeof body.bundle !== 'string') {
      throw new HttpError(400, '"bundle" must be a bundle id string');
    }
    const id = validBundleId(body.bundle);

    const bundle = new BundleStore(config.bundlesDir).open(id);
    if (!bundle) {
      throw new HttpError(404, unknownBundleMessage(id), 'NoSuchBundle');
    }
    return bundle;
  }

  if (body.bundleData !== undefined) {
    if (typeof body.bundleData !== 'string') {
      throw new HttpError(400, '"bundleData" must be a base64 string');
    }
    return openInline(decodeBundleData(body.bundleData, config), config);
  }

  return undefined;
}

/**
 * Strict about the alphabet where `Buffer.from` is forgiving: a caller whose
 * encoder produced something else is better told now than handed whatever
 * bytes a lenient decode salvages — which would fail as "not gzip", pointing
 * at the archive instead of the encoding.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBundleData(data: string, config: ServerConfig): Buffer {
  const compact = data.replace(/\s+/g, '');
  if (!BASE64.test(compact) || compact.length % 4 !== 0) {
    throw new HttpError(400, '"bundleData" is not valid base64');
  }

  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length > config.maxBundleBytes) {
    throw new HttpError(
      413,
      `"bundleData" decodes to ${bytes.length} bytes, over the ` +
        `${config.maxBundleBytes} byte limit`,
      'PayloadTooLarge',
    );
  }
  return bytes;
}

function openInline(bytes: Buffer, config: ServerConfig): OpenedBundle {
  const staging = mkdtempSync(
    join(config.workDir ?? tmpdir(), 'heddle-run-bundle-'),
  );
  const dispose = (): void => rmSync(staging, { recursive: true, force: true });

  try {
    const archive = join(staging, ARCHIVE_NAME);
    writeFileSync(archive, bytes);

    const bundle = openBundle(archive, {
      workDir: staging,
      origin: 'the request\'s "bundleData"',
    });
    // One dispose for the lot: the extraction directory is under `staging`,
    // so removing the staging root removes the archive and everything
    // `openBundle` unpacked from it.
    return { ...bundle, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

function assertBundlesEnabled(config: ServerConfig): void {
  if (config.bundles) return;
  throw new HttpError(
    400,
    'bundles are not accepted: this server was started with --no-bundles',
  );
}

function validBundleId(id: string): string {
  if (BUNDLE_ID.test(id)) return id;
  throw new HttpError(
    400,
    `"${id}" is not a bundle id. An id is 64 hex characters — the sha-256 of ` +
      `the archive, as POST /v1/bundles returned it.`,
  );
}

function unknownBundleMessage(id: string): string {
  return (
    `no bundle "${id}". A bundle is stored by POST /v1/bundles, which ` +
    `returns this id — or send the archive itself as "bundleData".`
  );
}
