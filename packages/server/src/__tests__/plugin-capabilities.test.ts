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
    expect(() => load(['callModel'])).not.toThrow();
  });

  it('is withheld the moment the server supplies a credential', () => {
    expect(() =>
      load(['callModel'], { defaultLlmKey: 'operator-key' }),
    ).toThrow(HttpError);
  });

  it('says why, rather than sending the author back to their manifest', () => {
    try {
      load(['callModel'], { defaultLlmKey: 'operator-key' });
      expect.unreachable('the load should have failed');
    } catch (err) {
      const message = (err as HttpError).message;
      expect(message).toMatch(/does not grant/);
      expect(message).toMatch(/supplies a default model credential/);
      expect(message).toMatch(/HEDDLE_LLM_DEFAULT_KEY/);
      expect(message).toMatch(/Granted here: runTool, emitEvent, log/);
    }
  });

  it('leaves the other three alone whatever the credential setting', () => {
    expect(() =>
      load(['runTool', 'emitEvent', 'log'], { defaultLlmKey: 'operator-key' }),
    ).not.toThrow();
  });

  it('reports a refused capability as the caller’s bad request', () => {
    try {
      load(['callModel'], { defaultLlmKey: 'operator-key' });
      expect.unreachable('the load should have failed');
    } catch (err) {
      expect((err as HttpError).status).toBe(400);
    }
  });
});

describe('a submitted plugin that ships middleware', () => {
  function loadMiddleware(): void {
    const workDir = mkdtempSync(join(tmpdir(), 'heddle-plugin-mw-'));
    cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));

    const config = resolveConfig({ allowRequestCode: true, workDir });
    const code: MaterializedCode = materializeRequestCode(
      {
        plugins: [
          {
            name: 'resilience',
            manifest: {
              name: 'resilience',
              version: '1.0.0',
              capabilities: [],
              components: [
                {
                  componentType: 'RetryPolicy',
                  kind: 'middleware',
                  seams: { nodeError: ['after'] },
                },
              ],
            },
            source: `serve({ RetryPolicy: { nodeError: { after: () => ({ action: 'retry' }) } } });`,
          },
        ],
      },
      config,
    );
    cleanups.push(() => code.dispose());

    const registry = buildPlugins(config, code);
    cleanups.push(() => registry.dispose());
  }

  it('is refused, because middleware runs on flows that never named it', () => {
    expect(() => loadMiddleware()).toThrow(HttpError);
  });

  it('says the middleware is the operator’s to install, and names it', () => {
    try {
      loadMiddleware();
      expect.unreachable('the load should have failed');
    } catch (err) {
      const message = (err as HttpError).message;
      expect(message).toMatch(/"RetryPolicy"/);
      expect(message).toMatch(/runs on every node of every flow/);
      expect(message).toMatch(/is a node, a transform or a provider/);
      expect((err as HttpError).status).toBe(400);
    }
  });
});

describe('a submitted plugin that ships a provider', () => {
  function loadProvider(serverOptions: Record<string, unknown> = {}): void {
    const workDir = mkdtempSync(join(tmpdir(), 'heddle-plugin-provider-'));
    cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));

    const config = resolveConfig({ allowRequestCode: true, workDir, ...serverOptions });
    const code: MaterializedCode = materializeRequestCode(
      {
        plugins: [
          {
            name: 'anthropic',
            manifest: {
              name: 'anthropic',
              version: '1.0.0',
              capabilities: [],
              components: [{ componentType: 'AnthropicConfig', kind: 'provider' }],
            },
            source: `serve({ AnthropicConfig: { chat: () => ({ content: 'hi', finish_reason: 'stop' }) } });`,
          },
        ],
      },
      config,
    );
    cleanups.push(() => code.dispose());

    const registry = buildPlugins(config, code);
    cleanups.push(() => registry.dispose());
  }

  it('is accepted, because a flow has to name it before it runs at all', () => {
    expect(() => loadProvider()).not.toThrow();
  });

  it('is still accepted on a server that supplies a credential', () => {
    expect(() => loadProvider({ defaultLlmKey: 'operator-key' })).not.toThrow();
  });
});
