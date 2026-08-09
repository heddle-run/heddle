import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BundleError } from '../../errors.js';
import { parseMount } from '../../workspace/mount.js';
import { BUNDLE_MANIFEST, validateBundleManifest } from '../format.js';
import { packBundle, type BundlePlan } from '../pack.js';
import { readTarGz, writeTarGz, type TarEntry } from '../tar.js';
import { extractBundle } from '../unpack.js';

const LIMITS = { maxBytes: 1024 * 1024, maxEntries: 256 };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heddle-bundle-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the tar layer', () => {
  it('round-trips files, directories and the executable bit', () => {
    const entries: TarEntry[] = [
      { name: 'a-dir' },
      { name: 'a-dir/plain.txt', data: Buffer.from('hello') },
      { name: 'tool.py', data: Buffer.from('#!/usr/bin/env python3\n'), executable: true },
      { name: 'empty', data: Buffer.alloc(0) },
    ];

    const back = readTarGz(writeTarGz(entries), LIMITS);

    expect(back.map((e) => e.name)).toEqual([
      'a-dir',
      'a-dir/plain.txt',
      'tool.py',
      'empty',
    ]);
    expect(back[1].data?.toString()).toBe('hello');
    expect(back[1].executable).toBe(false);
    expect(back[2].executable).toBe(true);
    expect(back[3].data?.length).toBe(0);
  });

  it('carries a path longer than one ustar name field', () => {
    const deep = `${'long-directory-name/'.repeat(8)}file.txt`;
    expect(deep.length).toBeGreaterThan(100);

    const back = readTarGz(
      writeTarGz([{ name: deep, data: Buffer.from('x') }]),
      LIMITS,
    );
    expect(back[0].name).toBe(deep);
  });

  it('refuses a path no split can fit', () => {
    const unsplittable = 'x'.repeat(120);
    expect(() => writeTarGz([{ name: unsplittable, data: Buffer.alloc(0) }])).toThrow(
      /too long/,
    );
  });

  it('is readable by the system tar', () => {
    const archive = writeTarGz([
      { name: 'nested' },
      { name: 'nested/file.txt', data: Buffer.from('via stock tar') },
    ]);
    const out = join(dir, 'archive.tgz');
    writeFileSync(out, archive);

    execFileSync('tar', ['-xzf', out, '-C', dir]);
    expect(readFileSync(join(dir, 'nested/file.txt'), 'utf-8')).toBe(
      'via stock tar',
    );
  });

  it('rejects what is not gzip, naming what a .heddle is', () => {
    expect(() => readTarGz(Buffer.from('{"not":"a bundle"}'), LIMITS)).toThrow(
      /does not start with gzip/,
    );
  });

  it('rejects an archive over the entry budget', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}`,
      data: Buffer.alloc(0),
    }));
    expect(() =>
      readTarGz(writeTarGz(entries), { maxBytes: 1024, maxEntries: 3 }),
    ).toThrow(/more than 3 entries/);
  });

  it('rejects a link entry rather than following it', () => {
    // Hand-built: our writer refuses to produce one, which is the point.
    const block = Buffer.alloc(512);
    block.write('evil-link', 0, 'utf8');
    block.write('0000644', 100, 'utf8');
    block.write('00000000000', 124, 'utf8');
    block[156] = 0x32; // '2': symlink
    block.write('ustar', 257, 'utf8');
    block.write('00', 263, 'utf8');
    block.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(sum.toString(8).padStart(6, '0'), 148, 6, 'utf8');
    block[154] = 0;
    block[155] = 0x20;

    const archive = gzipSync(Buffer.concat([block, Buffer.alloc(1024)]));
    expect(() => readTarGz(archive, LIMITS)).toThrow(/type '2'/);
  });
});

describe('the bundle manifest', () => {
  it('refuses a format from a newer heddle', () => {
    expect(() =>
      validateBundleManifest({ format: 99, name: 'x', flow: 'flow/f.json' }),
    ).toThrow(/made by a newer heddle/);
  });

  it('refuses a manifest path that climbs', () => {
    expect(() =>
      validateBundleManifest({ format: 1, name: 'x', flow: '../outside' }),
    ).toThrow(/steps outside the bundle/);
  });

  it('refuses an absolute manifest path', () => {
    expect(() =>
      validateBundleManifest({ format: 1, name: 'x', flow: '/etc/passwd' }),
    ).toThrow(/relative/);
  });

  it('reads requirements, still at format 1', () => {
    const manifest = validateBundleManifest({
      format: 1,
      name: 'x',
      flow: 'flow/f.json',
      requires: [{ binary: 'ffmpeg', hint: 'brew install ffmpeg' }],
    });

    // The field arrived without a version bump on purpose: an older heddle
    // ignores what it does not know and runs the bundle unchecked, where a bump
    // would have made it refuse the file outright.
    expect(manifest.format).toBe(1);
    expect(manifest.requires).toEqual([
      { binary: ['ffmpeg'], hint: 'brew install ffmpeg' },
    ]);
  });

  it('normalizes the older { env, binaries } object it may find there', () => {
    expect(
      validateBundleManifest({
        format: 1,
        name: 'x',
        flow: 'flow/f.json',
        requires: { env: ['OPENAI_API_KEY'], binaries: ['ffmpeg'] },
      }).requires,
    ).toEqual([{ binary: ['ffmpeg'] }, { env: 'OPENAI_API_KEY' }]);
  });

  it('leaves a manifest without the field exactly as it was', () => {
    const manifest = validateBundleManifest({
      format: 1,
      name: 'x',
      flow: 'flow/f.json',
    });

    expect(manifest.requires).toBeUndefined();
  });

  it('refuses a requirement it cannot read, naming the entry', () => {
    expect(() =>
      validateBundleManifest({
        format: 1,
        name: 'x',
        flow: 'flow/f.json',
        requires: [{ binary: 'ffmpeg' }, { nonsense: true }],
      }),
    ).toThrow(/requires\[1\] must name exactly one of/);
  });
});

describe('packing and extracting', () => {
  function writeFlow(): string {
    const path = join(dir, 'flow.json');
    writeFileSync(path, JSON.stringify({ name: 'demo' }));
    return path;
  }

  function plan(overrides: Partial<BundlePlan> = {}): BundlePlan {
    return {
      name: 'demo',
      flowPath: writeFlow(),
      pluginManifests: [],
      pluginConfig: {},
      mounts: [],
      ...overrides,
    };
  }

  it('round-trips the interactive proposal, and omits it when absent', () => {
    const chatty = join(dir, 'chatty.heddle');
    packBundle(plan({ interactive: true }), chatty);
    expect(extractBundle(chatty, join(dir, 'chatty-x')).interactive).toBe(true);

    const plain = join(dir, 'plain.heddle');
    packBundle(plan(), plain);
    expect(
      extractBundle(plain, join(dir, 'plain-x')).interactive,
    ).toBeUndefined();
  });

  it('round-trips the session and max-tool-rounds defaults', () => {
    const out = join(dir, 'defaults.heddle');
    packBundle(plan({ session: true, maxToolRounds: 'unlimited' }), out);
    const manifest = extractBundle(out, join(dir, 'defaults-x'));
    expect(manifest.session).toBe(true);
    expect(manifest.maxToolRounds).toBe('unlimited');

    const numeric = join(dir, 'numeric.heddle');
    packBundle(plan({ maxToolRounds: 40 }), numeric);
    expect(extractBundle(numeric, join(dir, 'numeric-x')).maxToolRounds).toBe(40);

    const plain = join(dir, 'plain2.heddle');
    packBundle(plan(), plain);
    const bare = extractBundle(plain, join(dir, 'plain2-x'));
    expect(bare.session).toBeUndefined();
    expect(bare.maxToolRounds).toBeUndefined();
  });

  it('refuses reading a max-tool-rounds that is not a real ceiling', () => {
    // The read is where the shape is enforced, so a hand-written bundle with a
    // nonsense value fails on the machine that runs it rather than silently.
    const written = join(dir, 'bad.heddle');
    packBundle(plan({ maxToolRounds: -3 }), written);
    expect(() => extractBundle(written, join(dir, 'bad-x'))).toThrow(
      /maxToolRounds/,
    );
  });

  it('round-trips a full bundle: flow, tools, plugin directory, mounts', () => {
    const toolsDir = join(dir, 'tools');
    mkdirSync(toolsDir);
    writeFileSync(join(toolsDir, 'greet.py'), '#!/usr/bin/env python3\n');
    chmodSync(join(toolsDir, 'greet.py'), 0o755);
    writeFileSync(join(toolsDir, 'notes.txt'), 'not executable');

    const pluginDir = join(dir, 'my-plugin');
    mkdirSync(pluginDir);
    const manifestPath = join(pluginDir, 'plugin.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'greeter',
        version: '1.0.0',
        tools: [{ name: 'wave', path: 'wave.sh' }],
      }),
    );
    writeFileSync(join(pluginDir, 'wave.sh'), '#!/bin/sh\n');
    chmodSync(join(pluginDir, 'wave.sh'), 0o755);

    const dataDir = join(dir, 'data');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'facts.md'), '# facts');
    const single = join(dir, 'single.txt');
    writeFileSync(single, 'one file');

    const out = join(dir, 'demo.heddle');
    const packed = packBundle(
      plan({
        toolsDir,
        pluginManifests: [manifestPath],
        pluginConfig: { RetryPolicy: { maxAttempts: 3 } },
        mounts: [
          parseMount(`${dataDir}:knowledge:ro`),
          parseMount(`${single}:notes/one.txt:rw`),
        ],
        input: { query: 'hi' },
      }),
      out,
    );

    expect(packed.plugins).toEqual(['greeter']);

    const extracted = join(dir, 'extracted');
    const manifest = extractBundle(out, extracted);

    expect(manifest).toMatchObject({
      format: 1,
      name: 'demo',
      flow: 'flow/flow.json',
      tools: 'tools',
      plugins: ['plugins/greeter/plugin.json'],
      pluginConfig: { RetryPolicy: { maxAttempts: 3 } },
      mounts: [
        { path: 'mounts/0', dest: 'knowledge', mode: 'ro' },
        { path: 'mounts/1', dest: join('notes', 'one.txt'), mode: 'rw' },
      ],
      input: { query: 'hi' },
    });

    // The executable bit — the whole of what makes a file a tool — survived.
    expect(statSync(join(extracted, 'tools/greet.py')).mode & 0o111).not.toBe(0);
    expect(statSync(join(extracted, 'tools/notes.txt')).mode & 0o111).toBe(0);
    expect(statSync(join(extracted, 'plugins/greeter/wave.sh')).mode & 0o111).not.toBe(0);
    expect(readFileSync(join(extracted, 'mounts/0/facts.md'), 'utf-8')).toBe('# facts');
    expect(readFileSync(join(extracted, 'mounts/1'), 'utf-8')).toBe('one file');
  });

  it('round-trips requirements, as written', () => {
    const out = join(dir, 'needs.heddle');
    packBundle(
      plan({
        requires: [
          { binary: ['whisper-cli'], hint: 'brew install whisper-cpp' },
          { binary: ['chromium', 'google-chrome'] },
          { env: 'OPENAI_API_KEY' },
          { file: '~/models/ggml-base.en.bin' },
          { node: '>=22' },
        ],
      }),
      out,
    );

    expect(extractBundle(out, join(dir, 'extracted')).requires).toEqual([
      { binary: ['whisper-cli'], hint: 'brew install whisper-cpp' },
      { binary: ['chromium', 'google-chrome'] },
      { env: 'OPENAI_API_KEY' },
      { file: '~/models/ggml-base.en.bin' },
      { node: '>=22' },
    ]);
  });

  it('carries no requires key when a bundle declares none', () => {
    const out = join(dir, 'plain.heddle');
    packBundle(plan(), out);

    const written = JSON.parse(
      readTarGz(readFileSync(out), LIMITS)
        .find((entry) => entry.name === BUNDLE_MANIFEST)!
        .data!.toString(),
    );

    // Not an empty list: every bundle that existed before this field is read
    // back byte for byte the same way, and nothing new is there to interpret.
    expect('requires' in written).toBe(false);
    expect(extractBundle(out, join(dir, 'extracted')).requires).toBeUndefined();
  });

  it('refuses to pack a symbolic link', () => {
    const dataDir = join(dir, 'data');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'real.txt'), 'x');
    symlinkSync(join(dataDir, 'real.txt'), join(dataDir, 'link.txt'));

    expect(() =>
      packBundle(
        plan({ mounts: [parseMount(dataDir)] }),
        join(dir, 'out.heddle'),
      ),
    ).toThrow(/symbolic link/);
  });

  it('refuses two plugins with one name', () => {
    const make = (sub: string): string => {
      const pluginDir = join(dir, sub);
      mkdirSync(pluginDir);
      const path = join(pluginDir, 'plugin.json');
      writeFileSync(
        path,
        JSON.stringify({
          name: 'twin',
          version: '1.0.0',
          tools: [{ name: `t_${sub}`, path: 't.sh' }],
        }),
      );
      writeFileSync(join(pluginDir, 't.sh'), '');
      return path;
    };

    expect(() =>
      packBundle(
        plan({ pluginManifests: [make('one'), make('two')] }),
        join(dir, 'out.heddle'),
      ),
    ).toThrow(/both named "twin"/);
  });

  it('refuses an archive with no heddle.json as not a bundle', () => {
    const out = join(dir, 'bare.heddle');
    writeFileSync(
      out,
      writeTarGz([{ name: 'flow.json', data: Buffer.from('{}') }]),
    );

    expect(() => extractBundle(out, join(dir, 'x'))).toThrow(
      /no heddle\.json at its root/,
    );
  });

  it('refuses an entry that would land outside the extraction', () => {
    const out = join(dir, 'escape.heddle');
    writeFileSync(
      out,
      writeTarGz([
        {
          name: BUNDLE_MANIFEST,
          data: Buffer.from(
            JSON.stringify({ format: 1, name: 'x', flow: 'flow/f.json' }),
          ),
        },
        { name: 'flow/f.json', data: Buffer.from('{}') },
        { name: 'a/../../escape.txt', data: Buffer.from('out') },
      ]),
    );

    expect(() => extractBundle(out, join(dir, 'x'))).toThrow(
      /steps outside the extraction directory/,
    );
  });

  it('refuses a manifest that names what the archive does not carry', () => {
    const out = join(dir, 'hollow.heddle');
    writeFileSync(
      out,
      writeTarGz([
        {
          name: BUNDLE_MANIFEST,
          data: Buffer.from(
            JSON.stringify({
              format: 1,
              name: 'x',
              flow: 'flow/f.json',
              tools: 'tools',
            }),
          ),
        },
        { name: 'flow/f.json', data: Buffer.from('{}') },
      ]),
    );

    expect(() => extractBundle(out, join(dir, 'x'))).toThrow(
      /does not carry it/,
    );
  });

  it('writes nothing when the manifest is refused', () => {
    const out = join(dir, 'bad.heddle');
    writeFileSync(
      out,
      writeTarGz([
        {
          name: BUNDLE_MANIFEST,
          data: Buffer.from(JSON.stringify({ format: 1, name: 'x', flow: '../up' })),
        },
        { name: 'innocent.txt', data: Buffer.from('x') },
      ]),
    );

    const target = join(dir, 'untouched');
    expect(() => extractBundle(out, target)).toThrow(BundleError);
    expect(() => statSync(join(target, 'innocent.txt'))).toThrow();
  });
});
