#!/usr/bin/env node
/**
 * heddle agent driver — lint, validate and *run* an Agent Spec flow with a stub
 * model, so a newly authored agent can be exercised end to end without an API
 * key and without spending a token.
 *
 *   node driver.mjs check <spec> [--tools-dir D] [--plugin M]...
 *   node driver.mjs run   <spec> [--tools-dir D] [--plugin M]... [--input JSON]
 *   node driver.mjs tool  <executable> [--input JSON]
 *
 * `run` starts a local OpenAI-compatible server and points the OpenAI SDK at it
 * with OPENAI_BASE_URL, so the spec runs unmodified. The stub answers every
 * model call: by default it calls each tool the agent offers once, then returns
 * a final answer, which walks the whole tool-calling loop.
 *
 * Agent tooling, not product surface — no dependencies beyond node's stdlib
 * (plus the workspace's `yaml`, when the spec is YAML and it resolves).
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** <repo>/.claude/skills/create-heddle-agent/driver.mjs -> <repo> */
const REPO = resolve(HERE, '../../..');
const STUB_KEY = 'heddle-driver-stub-key';
const PROBE = 'probe';

// Declared up here, not beside `loadSpec`: `main()` is called before this
// module finishes evaluating, so a const declared below it is still in its
// temporal dead zone by the time the first command runs.
const NO_YAML =
  'the "yaml" package did not resolve from this checkout, the working directory, ' +
  'or the heddle CLI, so the spec was not read here: lint checks and derived ' +
  'probe values are skipped. Install it (npm install yaml) or use a JSON spec.';

const IMPLICIT_OUTPUTS = {
  // An LlmNode writes this and only this, whatever its spec declares.
  LlmNode: ['generated_text'],
  // An AgentNode always writes `result`; more only if the model answers JSON.
  AgentNode: ['result'],
};

/** Node types whose real outputs are fixed, whatever the spec declares. */
const CLOSED_OUTPUTS = new Set(['LlmNode']);

/** What an agent carrying transforms writes besides its answer. */
const TRANSFORM_OUTPUTS = [
  'transform_status',
  'transform_reason',
  'transform_name',
  'transform_phase',
];

main().catch((err) => {
  console.error(`driver: ${err?.message ?? err}`);
  process.exit(2);
});

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  switch (command) {
    case 'check':
      process.exit(await check(opts));
    case 'run':
      process.exit(await run(opts));
    case 'tool':
      process.exit(await callTool(opts));
    default:
      usage();
      process.exit(command === undefined || command === '--help' ? 0 : 2);
  }
}

function usage() {
  console.log(
    [
      'usage:',
      '  node driver.mjs check <spec> [--tools-dir D] [--plugin M]...',
      '  node driver.mjs run   <spec> [--tools-dir D] [--plugin M]... [options]',
      '  node driver.mjs tool  <executable> [--input JSON]',
      '',
      'run options:',
      '  --input JSON           flow input (default: probe values for the start node)',
      '  --script FILE          scripted model turns, JSON array (default: call each tool once)',
      '  --args FILE            per-tool argument overrides, JSON {toolName: {...}}',
      '  --final TEXT           what the stub answers on its last turn',
      '  --transcript FILE      where to write what the model was sent',
      '  --plugin-config T=JSON passed through to heddle',
      '  --max-tool-calls N     stop the stub calling tools after N (default 8)',
      '  --allow-placeholders   do not fail on unsubstituted {{var}} in a prompt',
      '  --timeout MS           kill the run after this long (default 120000)',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const opts = { plugin: [], pluginConfig: [], positional: [] };
  const takesValue = new Set([
    '--tools-dir',
    '--input',
    '--script',
    '--args',
    '--final',
    '--transcript',
    '--max-tool-calls',
    '--timeout',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--plugin') opts.plugin.push(argv[++i]);
    else if (arg === '--plugin-config') opts.pluginConfig.push(argv[++i]);
    else if (arg === '--allow-placeholders') opts.allowPlaceholders = true;
    else if (takesValue.has(arg)) opts[camel(arg.slice(2))] = argv[++i];
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else opts.positional.push(arg);
  }
  return opts;
}

function camel(flag) {
  return flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/* ------------------------------------------------------------------ heddle */

/**
 * The heddle CLI, wherever this skill has been installed.
 *
 * Checked in order of how specific the answer is: an explicit HEDDLE_BIN, the
 * build inside a heddle checkout, a project-local install, then PATH. The skill
 * is installable into any project, so "no CLI here" is a normal outcome that has
 * to say what to do about it.
 */
function heddleBin() {
  if (process.env.HEDDLE_BIN) return process.env.HEDDLE_BIN.split(' ');

  const built = join(REPO, 'packages/cli/dist/heddle.js');
  if (existsSync(built)) return [process.execPath, built];

  const local = join(process.cwd(), 'node_modules/.bin/heddle');
  if (existsSync(local)) return [local];

  const onPath = onPathExecutable('heddle');
  if (onPath) return [onPath];

  throw new Error(
    `no heddle CLI found. Looked for a build at ${built}, ` +
      `${local}, and "heddle" on PATH. Inside a heddle checkout run ` +
      `"pnpm install && pnpm build"; otherwise install the CLI ` +
      `(npm install -g @heddle/cli, or brew install spichen/tap/heddle) or point ` +
      `HEDDLE_BIN at one.`,
  );
}

function onPathExecutable(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).mode & 0o111) return candidate;
    } catch {
      // Not here; try the next PATH entry.
    }
  }
  return undefined;
}

function heddleArgs(opts, subcommand, spec) {
  const args = [subcommand, spec];
  if (opts.toolsDir) args.push('--tools-dir', opts.toolsDir);
  for (const plugin of opts.plugin) args.push('--plugin', plugin);
  for (const config of opts.pluginConfig) args.push('--plugin-config', config);
  return args;
}

function spawnHeddle(args, env) {
  const [bin, ...prefix] = heddleBin();
  return spawn(bin, [...prefix, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collect(child, onLine) {
  let out = '';
  let err = '';
  let pending = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
    if (!onLine) return;
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line);
  });
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });

  return new Promise((done) => {
    child.on('close', (code, signal) => {
      if (onLine && pending.trim()) onLine(pending);
      done({ code, signal, out, err });
    });
  });
}

/* -------------------------------------------------------------- spec model */

/**
 * The spec as text and, when it can be parsed here, as an object.
 *
 * `doc` is undefined only for a YAML spec on a machine with no `yaml` package
 * reachable. That costs the lint and the derived probe values, not the run —
 * heddle parses the spec itself — so it is a warning, not an error.
 */
function loadSpec(path) {
  const text = readFileSync(path, 'utf8');
  if (!/\.ya?ml$/i.test(path)) return { text, doc: JSON.parse(text) };

  const yaml = loadYaml();
  if (!yaml) return { text, doc: undefined, unparsed: NO_YAML };
  return { text, doc: yaml.parse(text) };
}

/**
 * `yaml`, borrowed from wherever it already exists.
 *
 * Not a dependency of this skill — it has none — so it is resolved from the
 * places a heddle user already has it: the monorepo's core package, their own
 * project, or the CLI's own install tree.
 */
function loadYaml() {
  const roots = [join(REPO, 'packages/core/package.json'), join(process.cwd(), 'package.json')];

  try {
    roots.push(heddleBin().at(-1));
  } catch {
    // No CLI to borrow from; the other roots may still have it.
  }

  for (const root of roots) {
    try {
      return createRequire(root)('yaml');
    } catch {
      // Try the next root.
    }
  }
  return undefined;
}

/** Nodes by name, with `$component_ref` indirection resolved. */
function nodesOf(doc) {
  const referenced = doc?.$referenced_components ?? {};
  const deref = (entry) =>
    entry && entry.$component_ref ? referenced[entry.$component_ref] : entry;

  const nodes = new Map();
  for (const entry of doc?.nodes ?? []) {
    const node = deref(entry);
    if (node?.name) nodes.set(node.name, node);
  }
  // A flow may also reach a node only through an edge; index those too.
  for (const node of Object.values(referenced)) {
    if (node?.name && node.component_type?.endsWith('Node')) {
      if (!nodes.has(node.name)) nodes.set(node.name, node);
    }
  }
  return { nodes, deref };
}

function titles(properties) {
  return (properties ?? []).map((property) => property?.title).filter(Boolean);
}

function outputsOf(node) {
  const implicit = IMPLICIT_OUTPUTS[node.component_type] ?? [];
  // An LlmNode writes `generated_text` and nothing else, so anything else its
  // spec declares is decoration — the SDK's own validation accepts a data edge
  // reading it, and the runner then delivers nothing.
  if (CLOSED_OUTPUTS.has(node.component_type)) return implicit;

  const transformed = node.agent?.transforms?.length > 0 ? TRANSFORM_OUTPUTS : [];
  return [...new Set([...titles(node.outputs), ...implicit, ...transformed])];
}

function agentsOf(nodes) {
  const agents = [];
  for (const node of nodes.values()) {
    if (node.agent) agents.push({ node, agent: node.agent });
  }
  return agents;
}

/* -------------------------------------------------------------- check/lint */

async function check(opts) {
  const specPath = need(opts.positional[0], 'a spec path');
  const { doc, unparsed } = loadSpec(specPath);

  const problems = doc ? lint(doc, opts) : { errors: [], warnings: [unparsed] };
  const heddle = await collect(
    spawnHeddle(heddleArgs(opts, 'validate', specPath), { OPENAI_API_KEY: STUB_KEY }),
  );

  process.stdout.write(heddle.out);
  if (heddle.err.trim()) process.stderr.write(heddle.err);

  // An invalid graph exits 1, but a graph heddle could not compile at all is
  // still reported as "Graph validation skipped: <reason>" on a 0 status —
  // the skip is there so a check that could not run is not called a fault, and
  // here it is one either way. Read the output, not just the status.
  const skipped = /Graph validation skipped: (.*)/.exec(heddle.out);
  if (skipped) problems.errors.push(`heddle: graph validation failed — ${skipped[1]}`);
  if (heddle.code !== 0) {
    problems.errors.push(`heddle validate exited ${heddle.code}`);
  }

  return report('check', problems);
}

function lint(doc, opts) {
  const errors = [];
  const warnings = [];
  const { nodes, deref } = nodesOf(doc);

  if (doc?.component_type !== 'Flow') {
    warnings.push(
      `top-level component_type is "${doc?.component_type}", not "Flow" — ` +
        `the driver's run command only drives a Flow`,
    );
  }

  for (const edge of doc?.data_flow_connections ?? []) {
    const from = deref(edge.source_node)?.name ?? edge.source_node?.$component_ref;
    const to =
      deref(edge.destination_node)?.name ?? edge.destination_node?.$component_ref;
    const source = nodes.get(from);
    const destination = nodes.get(to);

    if (!source) {
      errors.push(`data edge "${edge.name}": no such source node "${from}"`);
      continue;
    }
    const available = outputsOf(source);
    if (available.length > 0 && !available.includes(edge.source_output)) {
      // The runner skips a mapping whose source key is absent, without a word:
      // the destination simply never receives the input.
      errors.push(
        `data edge "${edge.name}": ${source.component_type} "${from}" does not ` +
          `produce "${edge.source_output}" (it produces ${available.join(', ')}). ` +
          `The runner drops this mapping silently at run time.`,
      );
    }
    if (destination) {
      const inputs = titles(destination.inputs);
      if (inputs.length > 0 && !inputs.includes(edge.destination_input)) {
        warnings.push(
          `data edge "${edge.name}": "${to}" does not declare an input ` +
            `"${edge.destination_input}" (declares ${inputs.join(', ') || 'none'})`,
        );
      }
    }
  }

  lintBranches(doc, nodes, deref, errors, warnings);

  for (const { node, agent } of agentsOf(nodes)) {
    const written = new Set(['result', ...(agent.transforms?.length > 0 ? TRANSFORM_OUTPUTS : [])]);
    const declared = titles(node.outputs).filter((title) => !written.has(title));
    if (declared.length > 0) {
      warnings.push(
        `AgentNode "${node.name}" declares outputs ${declared.join(', ')} beyond ` +
          `"result". An agent only writes those if the model's final message is a ` +
          `JSON object with those keys — otherwise they are missing at run time.`,
      );
    }

    const url = agent.llm_config?.url;
    if (url) {
      warnings.push(
        `agent "${agent.name}" pins llm_config.url to ${url}. OPENAI_BASE_URL ` +
          `cannot redirect that, so "driver.mjs run" would send real requests ` +
          `there. Use OpenAiConfig (no url) to keep it stubbable.`,
      );
    }

    for (const tool of agent.tools ?? []) {
      if (!tool.description) {
        warnings.push(
          `tool "${tool.name}" on agent "${agent.name}" has no description — ` +
            `it is what the model reads to decide whether to call it`,
        );
      }
      for (const input of tool.inputs ?? []) {
        if (!input?.title) {
          errors.push(
            `tool "${tool.name}" has an input with no title; a tool input needs ` +
              `one, it becomes the JSON schema property name`,
          );
        }
      }
    }
  }

  if (opts.toolsDir) {
    // A loaded plugin may supply tools of its own, and those are not in the
    // tools directory — so an absent file is only conclusive without one.
    // `heddle validate` is the backstop either way: it composes both registries.
    const absent = opts.plugin.length > 0 ? warnings : errors;

    for (const { agent } of agentsOf(nodes)) {
      for (const tool of agent.tools ?? []) {
        const found = findExecutable(opts.toolsDir, tool.name);
        if (!found.found) {
          absent.push(
            `no executable for tool "${tool.name}" in ${opts.toolsDir} ` +
              `(a tool's name is its filename without the extension; a plugin ` +
              `can also supply one)`,
          );
        } else if (!found.executable) {
          errors.push(
            `${opts.toolsDir}/${found.file} is not executable — ` +
              `chmod +x it or heddle will not see tool "${tool.name}"`,
          );
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Where a branch leads, checked before a run finds out.
 *
 * Neither half of this is caught by `heddle validate`: a BranchingNode may map a
 * key to a branch nothing leaves on, and a control flow edge may name a branch
 * its source never declares. Both validate clean and both end the run mid-flight
 * with `no next node from "<node>"`.
 */
function lintBranches(doc, nodes, deref, errors, warnings) {
  const leaving = new Map();
  for (const edge of doc?.control_flow_connections ?? []) {
    const from = deref(edge.from_node)?.name;
    if (!from) continue;
    if (!leaving.has(from)) leaving.set(from, new Set());
    if (edge.from_branch) leaving.get(from).add(edge.from_branch);
  }

  for (const node of nodes.values()) {
    const declared = new Set(node.branches ?? []);
    const outgoing = leaving.get(node.name) ?? new Set();

    for (const branch of outgoing) {
      if (declared.size > 0 && !declared.has(branch)) {
        errors.push(
          `a control flow edge leaves "${node.name}" on branch "${branch}", which ` +
            `it does not declare (declares ${[...declared].join(', ') || 'none'})`,
        );
      }
    }

    if (node.component_type !== 'BranchingNode') continue;
    for (const [key, branch] of Object.entries(node.mapping ?? {})) {
      if (!outgoing.has(branch)) {
        errors.push(
          `BranchingNode "${node.name}" maps "${key}" to branch "${branch}", but no ` +
            `control flow edge leaves the node on it — the run ends with ` +
            `'no next node from "${node.name}"'`,
        );
      }
    }
    if (!node.mapping?.DEFAULT_BRANCH) {
      warnings.push(
        `BranchingNode "${node.name}" has no DEFAULT_BRANCH in its mapping. An ` +
          `unmapped key falls through to a branch literally named "default".`,
      );
    }
  }
}

/**
 * The file heddle would match this tool name to, and whether it can be run.
 *
 * A tool's name is its filename with the extension stripped, and the file has to
 * carry the executable bit — a `.py` in the tools directory that nobody chmodded
 * is not a tool, it is a file.
 */
function findExecutable(dir, name) {
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return { found: false, executable: false };
  }

  const match = files.find((file) => file.replace(/\.[^.]+$/, '') === name);
  if (!match) return { found: false, executable: false };

  try {
    return { found: true, executable: (statSync(join(dir, match)).mode & 0o111) !== 0, file: match };
  } catch {
    return { found: true, executable: false, file: match };
  }
}

function report(what, { errors, warnings }) {
  for (const warning of warnings) console.log(`  warn  ${warning}`);
  for (const error of errors) console.log(`  FAIL  ${error}`);

  const verdict = errors.length === 0 ? 'PASS' : 'FAIL';
  console.log(
    `${verdict} ${what}: ${errors.length} error(s), ${warnings.length} warning(s)`,
  );
  return errors.length === 0 ? 0 : 1;
}

/* -------------------------------------------------------------------- tool */

async function callTool(opts) {
  const exe = need(opts.positional[0], 'a tool executable');
  const input = opts.input ?? '{}';

  const child = spawn(resolve(exe), [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HEDDLE_WORKSPACE: process.env.HEDDLE_WORKSPACE ?? scratch('workspace'),
    },
  });
  child.stdin.end(input);
  const { code, out, err } = await collect(child);

  if (err.trim()) console.log(`stderr:\n${indent(err.trim())}`);
  console.log(`stdout:\n${indent(out.trim() || '(empty)')}`);

  const problems = { errors: [], warnings: [] };
  if (code !== 0) problems.errors.push(`exited ${code}`);
  try {
    const parsed = JSON.parse(out);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.errors.push('stdout is JSON but not an object');
    } else if (parsed.error) {
      problems.warnings.push(`the tool reported an error: ${oneLine(parsed.error)}`);
    }
  } catch {
    problems.errors.push(
      'stdout is not JSON. A tool must print one JSON object — heddle fails the ' +
        'call otherwise.',
    );
  }

  return report(`tool ${basename(exe)}`, problems);
}

/* --------------------------------------------------------------------- run */

async function run(opts) {
  const specPath = need(opts.positional[0], 'a spec path');
  const { doc, unparsed } = loadSpec(specPath);
  const { nodes } = nodesOf(doc);
  if (unparsed) console.log(`note       ${unparsed}`);

  const script = opts.script ? JSON.parse(readFileSync(opts.script, 'utf8')) : null;
  const argOverrides = opts.args ? JSON.parse(readFileSync(opts.args, 'utf8')) : {};
  const input = opts.input ?? JSON.stringify(probeInput(doc, nodes));
  const finalAnswer = opts.final ?? defaultAnswer(nodes);

  const stub = await startStub({
    script,
    argOverrides,
    finalAnswer,
    maxToolCalls: Number(opts.maxToolCalls ?? 8),
  });

  const frames = [];
  const child = spawnHeddle(
    [...heddleArgs(opts, 'run', specPath), '--input', input, '--protocol', 'heddle'],
    {
      OPENAI_API_KEY: STUB_KEY,
      OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}/v1`,
    },
  );

  const timeout = setTimeout(
    () => child.kill('SIGKILL'),
    Number(opts.timeout ?? 120000),
  );
  const result = await collect(child, (line) => {
    try {
      frames.push(JSON.parse(line));
    } catch {
      frames.push({ event: 'unparsed', data: { line } });
    }
  });
  clearTimeout(timeout);
  await stub.close();

  const transcriptPath =
    opts.transcript ??
    scratch(`${basename(dirname(resolve(specPath)))}-${basename(specPath)}.model.json`);
  writeFileSync(transcriptPath, `${JSON.stringify(stub.transcript, null, 2)}\n`);

  return summarize({
    input,
    frames,
    result,
    nodes,
    calls: stub.transcript,
    transcriptPath,
    opts,
  });
}

/** Probe values for whatever the start node says it emits. */
function probeInput(doc, nodes) {
  const startRef = doc?.start_node?.$component_ref;
  const start =
    [...nodes.values()].find((n) => n.id === startRef) ??
    [...nodes.values()].find((n) => n.component_type === 'StartNode');

  const values = {};
  for (const output of start?.outputs ?? []) {
    if (output?.title) values[output.title] = sample(output, output.title);
  }
  return Object.keys(values).length > 0 ? values : { query: `${PROBE} query` };
}

/**
 * What the stub answers last.
 *
 * A bare string when the flow only wants `result`; a JSON object when an agent
 * declares more, because merging the model's JSON answer into state is the only
 * way those keys get filled.
 */
function defaultAnswer(nodes) {
  const extra = new Set();
  for (const { node } of agentsOf(nodes)) {
    for (const title of titles(node.outputs)) {
      if (title !== 'result') extra.add(title);
    }
  }
  const text = 'stub answer from the heddle driver';
  if (extra.size === 0) return text;

  const answer = { result: text };
  for (const key of extra) answer[key] = text;
  return JSON.stringify(answer);
}

function sample(property, name) {
  const schema = property ?? {};
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  switch (schema.type) {
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return `${PROBE}:${name}`;
  }
}

/* -------------------------------------------------------------- stub model */

/**
 * A local OpenAI-compatible endpoint.
 *
 * Reached because `OpenAiConfig` never sets a base URL on the SDK client, so the
 * SDK falls back to OPENAI_BASE_URL. Serves both the streamed and the buffered
 * shape, since heddle streams unless a post transform is installed.
 */
async function startStub(config) {
  const transcript = [];
  let toolCalls = 0;

  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `stub: no route ${req.url}` } }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let request;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub: body is not JSON' } }));
        return;
      }

      const turn = nextTurn(request, config, transcript.length, () => toolCalls++);
      transcript.push({
        call: transcript.length + 1,
        streamed: request.stream === true,
        model: request.model,
        system: systemOf(request),
        tools_offered: (request.tools ?? []).map((t) => t.function?.name),
        messages: request.messages,
        reply: turn,
      });

      if (request.stream) streamTurn(res, request.model, turn);
      else sendTurn(res, request.model, turn);
    });
  });

  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));

  return {
    port: server.address().port,
    transcript,
    close: () => new Promise((closed) => server.close(closed)),
  };
}

/** The turn the stub plays: scripted if a script says so, else auto-drive. */
function nextTurn(request, config, index, countToolCall) {
  const scripted = config.script?.[index];
  if (scripted) {
    const calls = scripted.tools ??
      (scripted.tool ? [{ name: scripted.tool, arguments: scripted.arguments ?? {} }] : null);
    if (calls) {
      countToolCall();
      return { tool_calls: calls.map(toStubCall) };
    }
    return { content: scripted.content ?? config.finalAnswer };
  }
  if (config.script) return { content: config.finalAnswer };

  const offered = (request.tools ?? []).map((tool) => tool.function).filter(Boolean);
  const called = new Set(
    (request.messages ?? [])
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => call.function?.name),
  );
  const next = offered.find((tool) => !called.has(tool.name));

  if (!next || called.size >= config.maxToolCalls) {
    return { content: config.finalAnswer };
  }

  countToolCall();
  return {
    tool_calls: [
      toStubCall({
        name: next.name,
        arguments: config.argOverrides[next.name] ?? argsFor(next.parameters),
      }),
    ],
  };
}

function toStubCall(call, index = 0) {
  return {
    id: `stub_call_${index}_${call.name}`,
    type: 'function',
    function: {
      name: call.name,
      arguments:
        typeof call.arguments === 'string'
          ? call.arguments
          : JSON.stringify(call.arguments ?? {}),
    },
  };
}

function argsFor(parameters) {
  const properties = parameters?.properties ?? {};
  const required = parameters?.required ?? Object.keys(properties);
  const args = {};
  for (const name of required) {
    if (properties[name]) args[name] = sample(properties[name], name);
  }
  return args;
}

function sendTurn(res, model, turn) {
  const message = { role: 'assistant', content: turn.content ?? '' };
  if (turn.tool_calls) message.tool_calls = turn.tool_calls;

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'stub-completion',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: turn.tool_calls ? 'tool_calls' : 'stop',
        },
      ],
    }),
  );
}

function streamTurn(res, model, turn) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const send = (delta, finish) => {
    const chunk = {
      id: 'stub-completion',
      object: 'chat.completion.chunk',
      created: 0,
      model,
      choices: [{ index: 0, delta, finish_reason: finish ?? null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  if (turn.tool_calls) {
    turn.tool_calls.forEach((call, index) => {
      send({ tool_calls: [{ index, ...call }] });
    });
    send({}, 'tool_calls');
  } else {
    // Split so the token_delta path is exercised rather than one whole message.
    for (const word of String(turn.content ?? '').match(/\S+\s*/g) ?? ['']) {
      send({ content: word });
    }
    send({}, 'stop');
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

function systemOf(request) {
  return (request.messages ?? []).find((message) => message.role === 'system')?.content;
}

/* ----------------------------------------------------------------- summary */

function summarize({ input, frames, result, nodes, calls, transcriptPath, opts }) {
  const errors = [];
  const warnings = [];
  const by = (type) => frames.filter((frame) => frame.event === type);

  console.log(`input      ${input}`);
  console.log(`model calls ${calls.length}, frames ${frames.length}`);

  const nodeOrder = by('node_start').map((frame) => frame.data?.nodeName);
  console.log(`nodes      ${nodeOrder.join(' -> ') || '(none ran)'}`);

  for (const frame of by('tool_call')) {
    const { toolName, toolArgs } = frame.data ?? {};
    console.log(`tool call  ${toolName} ${JSON.stringify(toolArgs ?? {})}`);
  }
  for (const frame of by('tool_result')) {
    const { toolName, toolResult, error } = frame.data ?? {};
    console.log(
      `tool result ${toolName} ${error ? `ERROR ${error.message}` : JSON.stringify(toolResult)}`,
    );
    if (error) errors.push(`tool "${toolName}" failed: ${oneLine(error.message)}`);
    // An `error` key in a tool's own JSON is a report, not a failed call: the
    // model reads it and reacts. Worth surfacing, not worth failing on.
    else if (toolResult?.error) {
      warnings.push(`tool "${toolName}" reported: ${oneLine(toolResult.error)}`);
    }
  }
  for (const frame of by('warning')) {
    warnings.push(`heddle warning: ${oneLine(frame.data?.message)}`);
  }

  // A prompt still carrying {{key}} is a key the state never had — the usual
  // cause is a data flow edge that does not deliver, or a typo in the template.
  const unsubstituted = new Map();
  for (const call of calls) {
    for (const found of String(call.system ?? '').match(/{{\s*[\w.]+\s*}}/g) ?? []) {
      unsubstituted.set(found, (unsubstituted.get(found) ?? 0) + 1);
    }
  }
  for (const [placeholder, count] of unsubstituted) {
    const message =
      `a prompt reached the model still containing ${placeholder} ` +
      `(${count} of ${calls.length} model calls) — nothing in the node's state had that key`;
    if (opts.allowPlaceholders) warnings.push(message);
    else errors.push(message);
  }

  // What a node promised against what it actually wrote. `node_complete` carries
  // the node's own output, so a declared output missing from it is a key nothing
  // downstream can read — an LlmNode declaring anything but `generated_text`,
  // or an agent whose answer was prose where the spec wanted JSON fields.
  for (const frame of by('node_complete')) {
    const node = nodes.get(frame.data?.nodeName);
    const produced = frame.data?.state ?? {};
    if (!node || node.component_type === 'EndNode') continue;

    for (const title of titles(node.outputs)) {
      if (!(title in produced)) {
        warnings.push(
          `${node.component_type} "${node.name}" declares output "${title}" but ` +
            `produced ${Object.keys(produced).join(', ') || 'nothing'}`,
        );
      }
    }
  }

  // A `node_error` is not a verdict on its own: a middleware that retries or
  // substitutes leaves one behind on a run that then finishes cleanly. It counts
  // against the run only when the run did not recover from it.
  const recovered = by('flow_complete').length > 0 && result.code === 0;
  for (const frame of by('node_error')) {
    const message = `node "${frame.data?.nodeName}" errored: ${oneLine(frame.data?.error?.message)}`;
    if (recovered) warnings.push(`${message} (the run recovered)`);
    else errors.push(message);
  }

  const complete = by('flow_complete').at(-1);
  if (complete) {
    const state = complete.data?.state ?? {};
    console.log(`final state ${JSON.stringify(state, null, 2)}`);

    // An EndNode's output is its resolved input, so this is the one place a
    // data flow edge that delivered nothing becomes visible.
    for (const node of nodes.values()) {
      if (node.component_type !== 'EndNode') continue;
      for (const title of titles(node.inputs)) {
        if (!(title in state) && nodeOrder.includes(node.name)) {
          errors.push(
            `EndNode "${node.name}" declares input "${title}" but the run ended ` +
              `without it — nothing delivered that key`,
          );
        }
      }
    }
  } else {
    errors.push('no flow_complete frame — the run did not reach the end node');
  }
  if (result.code !== 0) {
    errors.push(`heddle run exited ${result.code}${result.signal ? ` (${result.signal})` : ''}`);
  }
  if (result.err.trim()) console.log(`stderr\n${indent(result.err.trim())}`);
  console.log(`transcript ${transcriptPath}`);

  return report('run', { errors, warnings });
}

/* ------------------------------------------------------------------- utils */

function scratch(name) {
  const dir = join(tmpdir(), 'heddle-driver');
  mkdirSync(dir, { recursive: true });
  return join(dir, name);
}

function need(value, what) {
  if (!value) throw new Error(`expected ${what}`);
  return value;
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
