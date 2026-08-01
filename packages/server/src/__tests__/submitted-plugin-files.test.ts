import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../config.js';
import { materializeRequestCode, type MaterializedCode } from '../request-code.js';
import { buildPlugins } from '../plugins.js';
import { HttpError } from '../errors.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function submit(manifestExtras: Record<string, unknown>) {
  const workDir = mkdtempSync(join(tmpdir(), 'heddle-submitted-files-'));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));

  const config = resolveConfig({ allowRequestCode: true, workDir });
  const code: MaterializedCode = materializeRequestCode(
    {
      plugins: [
        {
          name: 'skills',
          manifest: {
            name: 'skills',
            version: '1.0.0',
            capabilities: [],
            components: [{ componentType: 'Skills', kind: 'component' }],
            ...manifestExtras,
          },
          source: `serve({ Skills: { execute: () => ({ output: {} }) } });`,
        },
      ],
    },
    config,
  );
  cleanups.push(() => code.dispose());

  const registry = buildPlugins(config, code);
  cleanups.push(() => registry.dispose());
  return registry;
}

/**
 * A plugin's files land in the working directory of every node in the run,
 * before the flow starts and outside the toolCall seam. What a request may
 * carry is code that runs when something calls it; content in everybody's
 * working directory is the operator's to decide.
 */
describe('a submitted plugin declaring files', () => {
  it('is refused', () => {
    expect(() => submit({ files: [{ path: 'skills' }] })).toThrow(HttpError);
  });

  it('says where the content should go instead', () => {
    try {
      submit({ files: [{ path: 'skills' }] });
      expect.unreachable('the load should have failed');
    } catch (err) {
      expect((err as HttpError).status).toBe(400);
      expect((err as Error).message).toMatch(/no directory/);
      expect((err as Error).message).toMatch(/ask whoever runs this server/);
    }
  });

  it('is fine without them, so the refusal is about the field and not the plugin', () => {
    expect(() => submit({})).not.toThrow();
  });
});
