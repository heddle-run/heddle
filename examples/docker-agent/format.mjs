// An input format that reads a Docker agent file (cagent's YAML configuration,
// https://docs.docker.com/ai/docker-agent/configuration/overview/) and emits a
// Weave document. The format is the whole integration: everything downstream
// of `parse` — validation, compilation, the run — never learns the spec was
// not Weave to begin with.
//
// The translation covers the core a Docker agent file shares with Weave:
// the root agent, its instruction, and its model. What it cannot carry, it
// refuses by name rather than dropping — a toolset silently discarded would
// run a different agent than the file describes.

export default {
  name: 'docker-agent-format',
  version: '1.0.0',
  formats: [
    {
      name: 'docker-agent',
      // `.yaml` belongs to the builtin YAML format and cannot be claimed, so a
      // real-world `agent.yaml` is read with `--format docker-agent`. The
      // `.cagent` extension is this format's own, selected with no flag.
      extensions: ['.cagent'],
      parse: (text) => translate(readYamlSubset(text)),
    },
  ],
};

// ---------------------------------------------------------------------------
// The translation: Docker agent document in, Weave document out.
// ---------------------------------------------------------------------------

// Docker providers heddle's builtin (OpenAI-compatible) client can reach. DMR
// is Docker Model Runner, whose engine speaks the OpenAI API on localhost.
const PROVIDERS = {
  openai: { provider: 'openai' },
  dmr: {
    provider: 'openai-compatible',
    url: 'http://localhost:12434/engines/v1',
  },
};

// Fields whose meaning is executable capability or multi-agent structure. A
// fuller translator would pair this format with tools, custom component types
// or providers in the same plugin and translate these too; until it does,
// pretending they translated would be worse than refusing.
const UNSUPPORTED_AGENT_FIELDS = [
  'toolsets',
  'use_toolsets',
  'sub_agents',
  'hooks',
  'skills',
  'use_skills',
  'commands',
  'use_commands',
];
const UNSUPPORTED_TOP_FIELDS = ['rag', 'mcps', 'toolsets', 'skills', 'commands'];

function translate(doc) {
  const agents = expectMap(doc.agents, '"agents"');
  const root = expectMap(agents.root, '"agents.root"');

  refuseFields(doc, UNSUPPORTED_TOP_FIELDS, 'this file');
  refuseFields(root, UNSUPPORTED_AGENT_FIELDS, '"agents.root"');
  const others = Object.keys(agents).filter((name) => name !== 'root');
  if (others.length > 0) {
    throw new Error(
      `this file declares agents beyond "root" (${others.join(', ')}). ` +
        `Multi-agent delegation is "sub_agents", which this translator does ` +
        `not carry yet.`,
    );
  }

  const instruction =
    typeof root.instruction === 'string'
      ? root.instruction.trim()
      : 'You are a helpful assistant.';
  const name = slug(doc.metadata?.name ?? 'docker-agent');

  return {
    weave: 1,
    name,
    ...(typeof root.description === 'string'
      ? { description: root.description }
      : {}),
    inputs: { query: 'string' },
    // Top-level `agent:` is Weave's one-step sugar, which is exactly the
    // shape a Docker agent file describes.
    agent: {
      model: modelOf(root.model, doc.models ?? {}),
      // The visible seam between the two models: a Docker agent receives the
      // user's message as chat, a Weave agent receives flow inputs and
      // templates them into its prompt. The translator bridges it explicitly.
      prompt: `${instruction}\n\nThe user's request: {{inputs.query}}`,
    },
  };
}

function modelOf(modelRef, models) {
  let provider;
  let entry;

  if (typeof modelRef === 'string' && modelRef.includes('/')) {
    // The inline form: "openai/gpt-5".
    const slash = modelRef.indexOf('/');
    provider = modelRef.slice(0, slash);
    entry = { model: modelRef.slice(slash + 1) };
  } else {
    entry = expectMap(
      models[modelRef],
      `"models.${modelRef}" (named by "agents.root.model")`,
    );
    provider = entry.provider;
  }

  const known = PROVIDERS[provider];
  if (!known) {
    throw new Error(
      `provider "${provider}" has no client in heddle. Builtin support is ` +
        `OpenAI-compatible (${Object.keys(PROVIDERS).join(', ')}); another ` +
        `provider needs a provider plugin, which this same plugin could ` +
        `declare beside the format.`,
    );
  }

  const params = {};
  for (const key of ['temperature', 'max_tokens', 'top_p']) {
    if (entry[key] !== undefined) params[key] = entry[key];
  }

  return {
    provider: known.provider,
    model: expectString(entry.model, `the model of provider "${provider}"`),
    ...(known.url ? { url: entry.base_url ?? known.url } : {}),
    ...(entry.base_url && !known.url ? { url: entry.base_url } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

function refuseFields(map, fields, where) {
  for (const field of fields) {
    const value = map[field];
    const empty =
      value === undefined ||
      value === null ||
      (Array.isArray(value) && value.length === 0);
    if (empty) continue;

    throw new Error(
      `${where} declares "${field}", which this translator does not carry. ` +
        `It covers the agent/model core of a Docker agent file; carrying ` +
        `"${field}" would take tools or component types declared beside the ` +
        `format in this same plugin.`,
    );
  }
}

function expectMap(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`a Docker agent file needs ${what} to be a mapping`);
  }
  return value;
}

function expectString(value, what) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`a Docker agent file needs ${what} to be a string`);
  }
  return value;
}

function slug(value) {
  const cleaned = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'docker-agent';
}

// ---------------------------------------------------------------------------
// A deliberately small YAML reader: block mappings, block sequences, scalars,
// and literal/folded block scalars — enough for a Docker agent file. heddle's
// examples stay dependency-free so they run from a bare checkout; a real
// deployment of this format would import a YAML library here and delete all
// of this. Inline comments and flow syntax ({a: b}, [c]) are not supported.
// ---------------------------------------------------------------------------

function readYamlSubset(text) {
  const lines = text.split(/\r?\n/);
  let pos = 0;

  function current() {
    while (pos < lines.length) {
      const raw = lines[pos];
      if (raw.trim() === '' || raw.trimStart().startsWith('#')) {
        pos += 1;
        continue;
      }
      return {
        indent: raw.length - raw.trimStart().length,
        content: raw.trim(),
      };
    }
    return undefined;
  }

  function fail(message) {
    throw new Error(`${message} at line ${pos + 1}`);
  }

  function parseMapping(indent) {
    const map = {};
    for (;;) {
      const line = current();
      if (!line || line.indent < indent) return map;
      if (line.indent > indent) fail('unexpected indentation');

      const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line.content);
      if (!match) fail(`expected "key:", got "${line.content}"`);
      pos += 1;

      const rest = match[2].trim();
      if (rest === '') {
        const next = current();
        map[match[1]] =
          next && next.indent > indent
            ? next.content.startsWith('- ') || next.content === '-'
              ? parseSequence(next.indent)
              : parseMapping(next.indent)
            : null;
      } else if (/^[|>]-?$/.test(rest)) {
        map[match[1]] = parseBlockScalar(indent, rest);
      } else {
        map[match[1]] = scalarOf(rest);
      }
    }
  }

  function parseSequence(indent) {
    const items = [];
    for (;;) {
      const line = current();
      if (
        !line ||
        line.indent !== indent ||
        !(line.content === '-' || line.content.startsWith('- '))
      ) {
        return items;
      }

      const raw = lines[pos];
      const dash = raw.indexOf('-');
      const rest = line.content.slice(1).trim();
      if (/^[A-Za-z0-9_.-]+:/.test(rest)) {
        // A mapping item: blank the dash so the item parses as a mapping
        // indented past it, which also picks up its following lines.
        lines[pos] = `${raw.slice(0, dash)} ${raw.slice(dash + 1)}`;
        items.push(parseMapping(dash + 2));
      } else {
        pos += 1;
        items.push(rest === '' ? null : scalarOf(rest));
      }
    }
  }

  function parseBlockScalar(parentIndent, marker) {
    const kept = [];
    while (pos < lines.length) {
      const raw = lines[pos];
      if (raw.trim() === '') {
        kept.push('');
        pos += 1;
        continue;
      }
      if (raw.length - raw.trimStart().length <= parentIndent) break;
      kept.push(raw);
      pos += 1;
    }
    while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
    if (kept.length === 0) return '';

    const pad = Math.min(
      ...kept
        .filter((line) => line !== '')
        .map((line) => line.length - line.trimStart().length),
    );
    const body = kept.map((line) => (line === '' ? '' : line.slice(pad)));
    const joined = marker.startsWith('|')
      ? body.join('\n')
      : body.join(' ').replace(/ ?\n ?/g, '\n');
    return marker.endsWith('-') ? joined : `${joined}\n`;
  }

  function scalarOf(text) {
    if (
      (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
      (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
    ) {
      return text.slice(1, -1);
    }
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null' || text === '~') return null;
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    return text;
  }

  const first = current();
  if (!first) throw new Error('the file is empty');
  const doc = parseMapping(first.indent);
  if (current()) fail('unexpected indentation');
  return doc;
}
