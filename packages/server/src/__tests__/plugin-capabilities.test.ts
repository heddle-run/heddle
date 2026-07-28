/**
 * What this server grants a plugin a stranger submitted.
 *
 * The grant list in `plugins.ts` is written out longhand rather than derived
 * from `PLUGIN_CAPABILITIES`, so that a capability heddle learns is not handed
 * to callers by the act of upgrading. These tests are the other half of that
 * decision: they pin which verbs a submitted plugin gets, and — for `callModel`
 * — the one piece of configuration that takes a verb away again.
 */
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

/** A submitted plugin declaring whatever the case is about. */
function plugin(capabilities: string[]) {
  return {
    name: 'judge',
    manifest: {
      name: 'judge',
      version: '1.0.0',
      capabilities,
      components: [{ componentType: 'LlmJudge', kind: 'node' }],
    },
    source: `serve({ LlmJudge: { execute: () => ({ output: {} }) } });`,
  };
}

/** Load one submitted plugin against a server configured as the case describes. */
function load(capabilities: string[], serverOptions: Record<string, unknown> = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'heddle-plugin-caps-'));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));

  const config = resolveConfig({ allowRequestCode: true, workDir, ...serverOptions });
  const code: MaterializedCode = materializeRequestCode(
    { plugins: [plugin(capabilities)] },
    config,
  );
  cleanups.push(() => code.dispose());

  const registry = buildPlugins(config, code);
  cleanups.push(() => registry.dispose());
  return registry;
}

describe('callModel and the operator credential', () => {
  it('is granted when the only credential in play is the caller’s own', () => {
    // With no --default-llm-key, a submitted plugin's model call can only
    // reach a config its own spec brought — key included. Unbounded calls on
    // your own key are your own business.
    expect(() => load(['callModel'])).not.toThrow();
  });

  it('is withheld the moment the server supplies a credential', () => {
    // `execute` is opaque, so a plugin can make a thousand calls inside one
    // node while the flow shows one, and nothing in the engine bounds that.
    // Fine on the caller's key; not fine on the operator's.
    expect(() =>
      load(['callModel'], { defaultLlmKey: 'operator-key' }),
    ).toThrow(HttpError);
  });

  it('says why, rather than sending the author back to their manifest', () => {
    // The generic refusal — "this host does not grant callModel" — is true and
    // useless here: the manifest is correct, and the reason is a server flag
    // the plugin's author cannot see. `refusedBecause` is what carries the
    // operator's own sentence into core's message.
    try {
      load(['callModel'], { defaultLlmKey: 'operator-key' });
      expect.unreachable('the load should have failed');
    } catch (err) {
      const message = (err as HttpError).message;
      expect(message).toMatch(/does not grant/);
      expect(message).toMatch(/supplies a default model credential/);
      expect(message).toMatch(/--default-llm-key/);
      // And still says what is available, so a plugin asking for two things
      // and refused one of them can tell which.
      expect(message).toMatch(/Granted here: runTool, emitEvent, log/);
    }
  });

  it('leaves the other three alone whatever the credential setting', () => {
    // The rule is specific to spending a credential. Withholding `runTool` or
    // reporting alongside it would be a policy nobody asked for.
    expect(() =>
      load(['runTool', 'emitEvent', 'log'], { defaultLlmKey: 'operator-key' }),
    ).not.toThrow();
  });

  it('reports a refused capability as the caller’s bad request', () => {
    try {
      load(['callModel'], { defaultLlmKey: 'operator-key' });
      expect.unreachable('the load should have failed');
    } catch (err) {
      // 400, not 500: the submission is wrong for this server, and the caller
      // is the one who can do something about it.
      expect((err as HttpError).status).toBe(400);
    }
  });
});
