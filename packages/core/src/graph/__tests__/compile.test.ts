import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow } from '../../spec/parser.js';
import { compile } from '../compile.js';

const testdataDir = join(import.meta.dirname, '../../../testdata');

describe('compile', () => {
  it('compiles simple flow', () => {
    const data = readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8');
    const pf = parseFlow(data);
    const deps = {};

    const cg = compile(pf, deps);

    expect(cg.name).toBe('simple-flow');
    expect(cg.start).toBe('start');
    expect(cg.nodes.size).toBe(2);

    const startNode = cg.getNode('start');
    expect(startNode).toBeDefined();
    expect(startNode!.edges.length).toBe(1);
  });

  it('compiles branching flow', () => {
    const data = readFileSync(
      join(testdataDir, 'branching_flow.json'),
      'utf-8',
    );
    const pf = parseFlow(data);
    const deps = {};

    const cg = compile(pf, deps);

    const router = cg.getNode('router');
    expect(router).toBeDefined();
    expect(router!.edges.length).toBe(3);
  });

  it('builds data flow mappings', () => {
    const data = readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8');
    const pf = parseFlow(data);
    const deps = {};

    const cg = compile(pf, deps);

    const endNode = cg.getNode('end');
    expect(endNode).toBeDefined();

    const src = endNode!.inputMappings.get('input');
    expect(src).toBeDefined();
    expect(src!.sourceNode).toBe('start');
    expect(src!.sourceOutput).toBe('input');
  });
});
