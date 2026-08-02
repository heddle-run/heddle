import { gzipSync, gunzipSync } from 'node:zlib';
import { BundleError } from '../errors.js';

/**
 * A gzipped POSIX ustar archive, written and read with nothing but node:zlib.
 *
 * Hand-rolled rather than a dependency, and ustar rather than an invented
 * container, on purpose. heddle ships with no archive library and a bundle is
 * not a reason to acquire one; and a `.heddle` that any stock `tar -xzf` can
 * open is one a recipient can inspect without trusting heddle first. Only the
 * subset a bundle needs is spoken: plain files and directories, one mode bit
 * that matters (executable), no owners, no timestamps — a bundle built twice
 * from the same inputs is the same bytes.
 */

const BLOCK = 512;
const NAME_FIELD = 100;
const PREFIX_FIELD = 155;

const TYPE_FILE = 0x30; // '0'
const TYPE_FILE_OLD = 0x00; // pre-POSIX writers leave the field NUL
const TYPE_DIRECTORY = 0x35; // '5'
const TYPE_PAX = 0x78; // 'x' — per-file attributes we do not use
const TYPE_PAX_GLOBAL = 0x67; // 'g'

const GZIP_MAGIC = [0x1f, 0x8b];

export interface TarEntry {
  /** Path inside the archive, '/'-separated. A directory has no data. */
  name: string;
  data?: Buffer;
  executable?: boolean;
}

export interface TarLimits {
  maxBytes: number;
  maxEntries: number;
}

export function writeTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    blocks.push(header(entry));
    if (entry.data !== undefined && entry.data.length > 0) {
      blocks.push(entry.data);
      const spill = entry.data.length % BLOCK;
      if (spill > 0) blocks.push(Buffer.alloc(BLOCK - spill));
    }
  }

  // Two zero blocks are the end-of-archive marker readers stop at.
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(blocks));
}

export function readTarGz(archive: Buffer, limits: TarLimits): TarEntry[] {
  const tar = inflated(archive, limits);
  const entries: TarEntry[] = [];
  let offset = 0;
  let bytes = 0;

  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (isZero(block)) break;
    verifyChecksum(block, offset);

    const size = readOctal(block, 124, 12);
    const type = block[156];
    const name = entryName(block);
    offset += BLOCK;

    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (offset + padded > tar.length) {
      throw new BundleError(`bundle is truncated at "${name}"`);
    }

    if (type === TYPE_PAX || type === TYPE_PAX_GLOBAL) {
      // Attributes we never write and do not read; tolerated so an archive a
      // stock tar produced still opens.
      offset += padded;
      continue;
    }

    if (type === TYPE_FILE || type === TYPE_FILE_OLD) {
      bytes += size;
      entries.push({
        name,
        data: Buffer.from(tar.subarray(offset, offset + size)),
        executable: (readOctal(block, 100, 8) & 0o111) !== 0,
      });
    } else if (type === TYPE_DIRECTORY) {
      entries.push({ name: name.replace(/\/+$/, '') });
    } else {
      // A symlink is the important refusal: extracted first, it would turn a
      // later entry's write into a write through it, outside the extraction
      // directory. Nothing else in the zoo (devices, fifos, hard links) is
      // something a bundle can mean either.
      throw new BundleError(
        `bundle entry "${name}" has type '${String.fromCharCode(type)}', which ` +
          `a .heddle does not carry. A bundle is plain files and directories — ` +
          `a link would resolve outside the extraction, so it is refused.`,
      );
    }

    offset += padded;
    assertWithinLimits(entries.length, bytes, limits);
  }

  return entries;
}

function inflated(archive: Buffer, limits: TarLimits): Buffer {
  if (archive.length < 2 || archive[0] !== GZIP_MAGIC[0] || archive[1] !== GZIP_MAGIC[1]) {
    throw new BundleError(
      'not a heddle bundle: the file does not start with gzip. A .heddle is a ' +
        'gzipped tar archive with a heddle.json inside — was this file made ' +
        'with "heddle bundle"?',
    );
  }

  try {
    // The cap covers content plus headers and padding, so a bomb fails in
    // zlib before anything is allocated for it.
    return gunzipSync(archive, {
      maxOutputLength: limits.maxBytes + BLOCK * 2 * (limits.maxEntries + 2),
    });
  } catch (err) {
    throw new BundleError('failed to decompress the bundle', { cause: err });
  }
}

function assertWithinLimits(
  entries: number,
  bytes: number,
  limits: TarLimits,
): void {
  if (entries > limits.maxEntries) {
    throw new BundleError(
      `bundle holds more than ${limits.maxEntries} entries`,
    );
  }
  if (bytes > limits.maxBytes) {
    throw new BundleError(
      `bundle unpacks to more than ${limits.maxBytes} bytes`,
    );
  }
}

function header(entry: TarEntry): Buffer {
  const directory = entry.data === undefined;
  const { name, prefix } = splitName(
    directory ? `${entry.name}/` : entry.name,
  );

  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, NAME_FIELD, 'utf8');
  writeOctal(block, 100, 8, directory || entry.executable ? 0o755 : 0o644);
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, entry.data?.length ?? 0);
  writeOctal(block, 136, 12, 0); // mtime: fixed, so equal inputs are equal bytes
  block[156] = directory ? TYPE_DIRECTORY : TYPE_FILE;
  block.write('ustar', 257, 'utf8');
  block.write('00', 263, 2, 'utf8');
  block.write(prefix, 345, PREFIX_FIELD, 'utf8');

  writeChecksum(block);
  return block;
}

/**
 * Fit a path into ustar's two name fields.
 *
 * The header holds 100 bytes of name and 155 of prefix, joined at a '/'. Most
 * bundle paths fit the name alone; a longer one is split at whichever slash
 * leaves both halves in range. One that cannot be split is refused rather than
 * truncated — a truncated path extracts to the wrong place.
 */
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= NAME_FIELD) return { name: path, prefix: '' };

  for (let cut = path.length - 1; cut > 0; cut--) {
    if (path[cut] !== '/') continue;
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (
      Buffer.byteLength(prefix) <= PREFIX_FIELD &&
      name.length > 0 &&
      Buffer.byteLength(name) <= NAME_FIELD
    ) {
      return { name, prefix };
    }
  }

  throw new BundleError(
    `"${path}" is too long for a bundle entry (${NAME_FIELD} bytes after the ` +
      `last directory that fits, ${PREFIX_FIELD} before it). Shorten the path.`,
  );
}

function writeOctal(
  block: Buffer,
  at: number,
  width: number,
  value: number,
): void {
  block.write(value.toString(8).padStart(width - 1, '0'), at, width - 1, 'utf8');
  // The trailing byte is already NUL from alloc.
}

function readOctal(block: Buffer, at: number, width: number): number {
  const text = block
    .subarray(at, at + width)
    .toString('utf8')
    .replace(/\0.*$/, '')
    .trim();
  if (text.length === 0) return 0;

  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value) || value < 0) {
    throw new BundleError(`corrupt bundle: bad number in a tar header`);
  }
  return value;
}

function writeChecksum(block: Buffer): void {
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0'), 148, 6, 'utf8');
  block[154] = 0;
  block[155] = 0x20;
}

function verifyChecksum(block: Buffer, offset: number): void {
  const recorded = readOctal(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : block[i];
  }
  if (sum !== recorded) {
    throw new BundleError(
      `corrupt bundle: header checksum mismatch at byte ${offset}`,
    );
  }
}

function entryName(block: Buffer): string {
  const name = cString(block, 0, NAME_FIELD);
  const prefix = cString(block, 345, PREFIX_FIELD);
  return prefix.length > 0 ? `${prefix}/${name}` : name;
}

function cString(block: Buffer, at: number, width: number): string {
  const field = block.subarray(at, at + width);
  const end = field.indexOf(0);
  return field.toString('utf8', 0, end === -1 ? width : end);
}

function isZero(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}
