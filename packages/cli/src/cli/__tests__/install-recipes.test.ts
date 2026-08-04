import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { describeRecipe, installRecipes } from '../install-recipes.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A PATH that either holds a fake brew, or holds nothing at all. */
function fakePath(withBrew: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-recipes-'));
  tempDirs.push(dir);
  if (withBrew) {
    const brew = join(dir, 'brew');
    writeFileSync(brew, '#!/bin/sh\n');
    chmodSync(brew, 0o755);
  }
  return dir;
}

describe('the curated install table', () => {
  it('maps whisper-cli and ffmpeg to their brew packages', () => {
    const recipes = installRecipes(
      [
        { requirement: { binary: ['whisper-cli'] }, label: 'whisper-cli' },
        { requirement: { binary: ['ffmpeg'] }, label: 'ffmpeg' },
      ],
      { PATH: fakePath(true) },
    );

    expect(recipes.map(describeRecipe)).toEqual([
      'brew install whisper-cpp',
      'brew install ffmpeg',
    ]);
  });

  it('offers no command where brew is not', () => {
    const recipes = installRecipes(
      [{ requirement: { binary: ['whisper-cli'] }, label: 'whisper-cli' }],
      { PATH: fakePath(false) },
    );

    expect(recipes).toEqual([]);
  });

  it('downloads a model only to its own destination', () => {
    const env = { PATH: fakePath(false) };
    const home = [
      {
        requirement: { file: '~/.heddle/models/ggml-base.en.bin' },
        label: '~/.heddle/models/ggml-base.en.bin',
      },
    ];
    // Same basename, different place: a declaration must not be able to point
    // heddle's download anywhere the table does not already write.
    const elsewhere = [
      {
        requirement: { file: '~/Downloads/ggml-base.en.bin' },
        label: '~/Downloads/ggml-base.en.bin',
      },
    ];

    const offered = installRecipes(home, env);
    expect(offered).toHaveLength(1);
    expect(describeRecipe(offered[0])).toContain('https://huggingface.co/ggml-org/whisper.cpp');
    expect(describeRecipe(offered[0])).toContain(join(homedir(), '.heddle', 'models'));
    expect(installRecipes(elsewhere, env)).toEqual([]);
  });

  it('knows nothing it was not taught', () => {
    const recipes = installRecipes(
      [
        { requirement: { env: 'OPENAI_API_KEY' }, label: 'OPENAI_API_KEY' },
        { requirement: { binary: ['some-other-tool'] }, label: 'some-other-tool' },
        { requirement: { node: '>=22' }, label: 'node >=22' },
      ],
      { PATH: fakePath(true) },
    );

    expect(recipes).toEqual([]);
  });
});
