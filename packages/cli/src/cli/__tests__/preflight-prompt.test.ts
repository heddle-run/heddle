import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, it, expect } from 'vitest';
import { RequirementError, type Requirement } from '@heddle-run/core';
import { describeRecipe, type InstallRecipe } from '../install-recipes.js';
import { waitForRequirements } from '../preflight-prompt.js';

/**
 * A terminal whose answers can change the machine between reads — the way a
 * real pause is used: the operator fixes something in another shell, then
 * presses enter. `answers` are consumed in order; each may carry a `before`
 * that runs as the "fix" the operator made while the prompt waited.
 */
function terminal(
  answers: Array<{ value: string | undefined; before?: () => void }>,
) {
  const written: string[] = [];
  const questions: string[] = [];

  return {
    written,
    questions,
    options: {
      interactive: true,
      write: (text: string) => written.push(text),
      read: (question: string) => {
        questions.push(question);
        const next = answers.shift();
        if (!next) throw new Error('the prompt asked more than the test allowed');
        next.before?.();
        return Promise.resolve(next.value);
      },
    },
  };
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fresh PATH directory holding only `brew` — enough for the recipe table to
 * make its offer, empty of everything a test wants to see appear. One per
 * test, so an installed fake cannot leak into the next test's machine.
 */
function pathWithBrew(): string {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-preflight-'));
  tempDirs.push(dir);
  fakeExecutable(dir, 'brew');
  return dir;
}

function fakeExecutable(dir: string, name: string): void {
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
}

describe('pausing a run at its unmet requirements', () => {
  it('asks nothing when everything already holds', async () => {
    const io = terminal([]);

    await waitForRequirements([{ node: '>=1' }], 'demo', {
      ...io.options,
      env: {},
    });

    expect(io.written).toEqual([]);
    expect(io.questions).toEqual([]);
  });

  it('asks nothing when nothing is declared', async () => {
    const io = terminal([]);

    await waitForRequirements([], 'demo', { ...io.options, env: {} });

    expect(io.written).toEqual([]);
  });

  it('continues once the machine is fixed and enter is pressed', async () => {
    const env: NodeJS.ProcessEnv = {};
    const io = terminal([
      // The operator exports nothing here — the prompt cannot reach another
      // shell — but a file appearing or PATH gaining a binary looks exactly
      // like this: the world changed while the question was open.
      { value: '', before: () => (env.OPENAI_API_KEY = 'sk-typed') },
    ]);

    await waitForRequirements([{ env: 'OPENAI_API_KEY' }], 'demo', {
      ...io.options,
      env,
    });

    const screen = io.written.join('');
    expect(screen).toContain('demo cannot run here — 1 requirement unmet');
    expect(screen).toContain('Everything holds now — starting.');
    // The question says whose job the fix is, in so many words.
    expect(io.questions[0]).toContain('heddle has no recipe');
  });

  it('keeps re-checking, and re-reporting, until the list is empty', async () => {
    const env: NodeJS.ProcessEnv = {};
    const io = terminal([
      { value: '' }, // pressed enter without fixing anything
      { value: '', before: () => (env.A = 'set') },
      { value: '', before: () => (env.B = 'set') },
    ]);

    await waitForRequirements([{ env: 'A' }, { env: 'B' }], 'demo', {
      ...io.options,
      env,
    });

    const reports = io.written.filter((text) => text.includes('cannot run here'));
    expect(reports).toHaveLength(3);
    expect(reports[0]).toContain('2 requirements unmet');
    expect(reports[2]).toContain('1 requirement unmet');
  });

  it('stops on q with a short error, the list already on screen', async () => {
    const io = terminal([{ value: 'q' }]);

    const wait = waitForRequirements(
      [{ binary: ['absent-tool-6f2a'], hint: 'brew install it' }],
      'demo',
      { ...io.options, env: {} },
    );

    await expect(wait).rejects.toThrow(RequirementError);
    await expect(wait).rejects.toThrow(/still has 1 unmet requirement/);
    // The report was written, not repeated into the error.
    expect(io.written.join('')).toContain('brew install it');
  });

  it('treats end-of-input as stopping', async () => {
    const io = terminal([{ value: undefined }]);

    await expect(
      waitForRequirements([{ env: 'KEY' }], 'demo', { ...io.options, env: {} }),
    ).rejects.toThrow(RequirementError);
  });

  it('runs an accepted recipe and starts once it lands', async () => {
    const bin = pathWithBrew();
    const executed: string[] = [];
    const io = terminal([{ value: 'y' }]);

    await waitForRequirements([{ binary: ['whisper-cli'] }], 'demo', {
      ...io.options,
      env: { PATH: bin },
      execute: async (recipe: InstallRecipe) => {
        executed.push(describeRecipe(recipe));
        fakeExecutable(bin, 'whisper-cli'); // what a real brew install leaves behind
      },
    });

    expect(executed).toEqual(['brew install whisper-cpp']);
    const screen = io.written.join('');
    // Consent is informed: the exact command is on screen before the question.
    expect(screen).toContain('brew install whisper-cpp');
    expect(screen).toContain('Everything holds now — starting.');
    expect(io.questions[0]).toContain('Run that now?');
  });

  it('offers once; declining leaves every fix to the operator', async () => {
    const bin = pathWithBrew();
    const executed: string[] = [];
    const io = terminal([
      { value: 'n' },
      { value: '' }, // enter, nothing fixed — the offer must not come back
      { value: '', before: () => fakeExecutable(bin, 'whisper-cli') },
    ]);

    await waitForRequirements([{ binary: ['whisper-cli'] }], 'demo', {
      ...io.options,
      env: { PATH: bin },
      execute: async (recipe: InstallRecipe) => {
        executed.push(describeRecipe(recipe));
      },
    });

    expect(executed).toEqual([]);
    const offers = io.questions.filter((q) => q.includes('Run that now?'));
    expect(offers).toHaveLength(1);
    expect(io.questions[1]).toContain('The rest of the fixes are yours');
  });

  it('holds the pause when a recipe fails, error on screen', async () => {
    const io = terminal([{ value: 'y' }, { value: 'q' }]);

    const wait = waitForRequirements([{ binary: ['whisper-cli'] }], 'demo', {
      ...io.options,
      env: { PATH: pathWithBrew() },
      execute: async () => {
        throw new Error('brew exited with 1');
      },
    });

    await expect(wait).rejects.toThrow(RequirementError);
    expect(io.written.join('')).toContain('That did not land: brew exited with 1');
  });

  it('refuses without pausing when nothing can answer', async () => {
    const io = terminal([]);
    const requires: Requirement[] = [
      { binary: ['absent-tool-6f2a'], hint: 'brew install it' },
      { env: 'KEY' },
    ];

    const wait = waitForRequirements(requires, 'demo', {
      ...io.options,
      interactive: false,
      env: {},
    });

    // The non-interactive failure is the whole report — CI has no screen with
    // the list already on it.
    await expect(wait).rejects.toThrow(/demo cannot run here — 2 requirements/);
    await expect(wait).rejects.toThrow(/brew install it/);
    expect(io.questions).toEqual([]);
  });
});
