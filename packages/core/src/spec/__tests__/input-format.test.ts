import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inputFormatByName,
  inputFormatForPath,
  JSON_INPUT_FORMAT,
  YAML_INPUT_FORMAT,
  type InputFormatDef,
} from '../input-format.js';
import { parseFlowWith } from '../parser.js';
import { loadFlow } from '../load.js';
import { PluginRegistry } from '../../plugin/registry.js';
import { definePlugin } from '../../plugin/types.js';

const testdataDir = join(import.meta.dirname, '../../../testdata');

// A wire format of its own: base64-wrapped JSON. Small enough to define
// inline, foreign enough that nothing but the adapter could have read it.
const b64Format: InputFormatDef = {
  name: 'b64',
  extensions: ['.b64'],
  parse: (text) => JSON.parse(Buffer.from(text, 'base64').toString('utf-8')),
};

function registryWithB64(): PluginRegistry {
  return PluginRegistry.fromPlugins([
    definePlugin({ name: 'b64-plugin', version: '1.0.0', formats: [b64Format] }),
  ]);
}

describe('inputFormatByName', () => {
  it('resolves the builtins', () => {
    expect(inputFormatByName('json')).toBe(JSON_INPUT_FORMAT);
    expect(inputFormatByName('yaml')).toBe(YAML_INPUT_FORMAT);
  });

  it('resolves a plugin-provided format', () => {
    expect(inputFormatByName('b64', registryWithB64())).toBe(b64Format);
  });

  it('refuses an unknown name and lists what could have been', () => {
    expect(() => inputFormatByName('toml', registryWithB64())).toThrow(
      /unknown input format "toml".*json, yaml, b64/s,
    );
  });
});

describe('inputFormatForPath', () => {
  it('resolves builtin extensions, case-insensitively', () => {
    expect(inputFormatForPath('flow.yaml').name).toBe('yaml');
    expect(inputFormatForPath('flow.yml').name).toBe('yaml');
    expect(inputFormatForPath('FLOW.YAML').name).toBe('yaml');
    expect(inputFormatForPath('flow.json').name).toBe('json');
  });

  it('falls back to JSON for an unclaimed or missing extension', () => {
    expect(inputFormatForPath('flow.txt').name).toBe('json');
    expect(inputFormatForPath('/dev/stdin').name).toBe('json');
    expect(inputFormatForPath('.hidden').name).toBe('json');
  });

  it('resolves a plugin-claimed extension', () => {
    expect(inputFormatForPath('flow.b64', registryWithB64()).name).toBe('b64');
  });
});

describe('parseFlowWith', () => {
  it('parses a flow through a custom format', () => {
    const json = readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8');
    const encoded = Buffer.from(json, 'utf-8').toString('base64');

    const flow = parseFlowWith(b64Format, encoded, registryWithB64());

    expect(flow.name).toBe('simple-flow');
    expect(flow.parsedNodes.length).toBe(2);
  });

  it('names the format when it yields no top-level object', () => {
    expect(() => parseFlowWith(b64Format, Buffer.from('[]').toString('base64')))
      .toThrow('B64 must contain a top-level object');
  });
});

describe('loadFlow with an explicit format', () => {
  it('reads a file whose extension says nothing', () => {
    const yaml = readFileSync(join(testdataDir, 'simple_flow.yaml'), 'utf-8');
    const dir = mkdtempSync(join(tmpdir(), 'heddle-format-test-'));
    const path = join(dir, 'flow.txt');
    writeFileSync(path, yaml);

    expect(() => loadFlow(path)).toThrow();
    expect(loadFlow(path, undefined, { format: 'yaml' }).name).toBe(
      'simple-flow',
    );
  });

  it('reads a plugin format by extension', () => {
    const json = readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8');
    const dir = mkdtempSync(join(tmpdir(), 'heddle-format-test-'));
    const path = join(dir, 'flow.b64');
    writeFileSync(path, Buffer.from(json, 'utf-8').toString('base64'));

    expect(loadFlow(path, registryWithB64()).name).toBe('simple-flow');
  });

  it('refuses an unknown format name', () => {
    expect(() =>
      loadFlow(join(testdataDir, 'simple_flow.json'), undefined, {
        format: 'toml',
      }),
    ).toThrow(/unknown input format "toml"/);
  });
});

describe('input format registration', () => {
  it('carries formats across extend()', () => {
    const extended = registryWithB64().extend();
    expect(extended.inputFormatDef('b64')).toBe(b64Format);
    expect(extended.inputFormatForExtension('.b64')).toBe(b64Format);
    expect(extended.inputFormatNames()).toEqual(['b64']);
  });

  it('refuses a builtin name', () => {
    const plugin = definePlugin({
      name: 'p',
      version: '1.0.0',
      formats: [{ ...b64Format, name: 'json' }],
    });
    expect(() => PluginRegistry.fromPlugins([plugin])).toThrow(
      /input format "json", which is builtin/,
    );
  });

  it('refuses a malformed name', () => {
    const plugin = definePlugin({
      name: 'p',
      version: '1.0.0',
      formats: [{ ...b64Format, name: 'B64!' }],
    });
    expect(() => PluginRegistry.fromPlugins([plugin])).toThrow(
      /whose name is "B64!"/,
    );
  });

  it('refuses two plugins claiming one format name', () => {
    const one = definePlugin({ name: 'one', version: '1.0.0', formats: [b64Format] });
    const two = definePlugin({ name: 'two', version: '1.0.0', formats: [b64Format] });
    expect(() => PluginRegistry.fromPlugins([one, two])).toThrow(
      /"one" and "two" both provide the input format "b64"/,
    );
  });

  it('refuses a builtin extension', () => {
    const plugin = definePlugin({
      name: 'p',
      version: '1.0.0',
      formats: [{ ...b64Format, name: 'my-yaml', extensions: ['.yaml'] }],
    });
    expect(() => PluginRegistry.fromPlugins([plugin])).toThrow(
      /claiming "\.yaml", which belongs to the builtin "yaml" format/,
    );
  });

  it('refuses two plugins claiming one extension', () => {
    const one = definePlugin({ name: 'one', version: '1.0.0', formats: [b64Format] });
    const two = definePlugin({
      name: 'two',
      version: '1.0.0',
      formats: [{ ...b64Format, name: 'other' }],
    });
    expect(() => PluginRegistry.fromPlugins([one, two])).toThrow(
      /both claim the extension "\.b64"/,
    );
  });

  it('refuses an extension without its dot', () => {
    const plugin = definePlugin({
      name: 'p',
      version: '1.0.0',
      formats: [{ ...b64Format, extensions: ['b64'] }],
    });
    expect(() => PluginRegistry.fromPlugins([plugin])).toThrow(
      /"\.toml", not "toml"/,
    );
  });
});
