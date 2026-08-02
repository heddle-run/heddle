# @heddle-run/core

The engine behind [heddle](https://heddle.run): parsing and validating
[Open Agent Specification](https://oracle.github.io/agent-spec/) documents,
compiling them into a graph, and running it: node executors, the tool
subprocess protocol, LLM providers, the plugin system.

Most people want [`@heddle-run/cli`](https://www.npmjs.com/package/@heddle-run/cli)
instead, which is this engine behind a command:

```bash
npx @heddle-run/cli run flow.json --tools-dir tools --input '{"query": "hello"}'
```

Reach for the library when you are embedding a flow in a program of your own,
whether that is serving it, checking it in CI, or wrapping it in something that
is not a CLI.

```bash
npm install @heddle-run/core
```

## Parse, compile, check

```js
import { loadFlow, compile, validate, collectToolNames } from '@heddle-run/core';

const flow = loadFlow('flow.json');
validate(compile(flow, {}));

console.log(`${flow.name}: ${collectToolNames(flow).join(', ')}`);
```

`loadFlow` reads JSON or YAML and resolves every `$component_ref`. `compile`
turns the document into an executable graph, and `validate` refuses one that is
not well-formed, such as unreachable nodes or edges to nowhere, before anything
runs.

To execute it, hand `compile` the dependencies a run needs (a tool registry, a
tool executor, an event handler) and pass the graph to `Runner`. A flow naming a
plugin component type has to be loaded with that plugin: `loadFlow(path,
plugins)`, from `loadPlugins`.

## The rest

Full documentation lives at [heddle.run/docs](https://heddle.run/docs); the
plugin interfaces, seams and event contract are covered there.
[`@heddle-run/server`](https://www.npmjs.com/package/@heddle-run/server) is this engine
behind an HTTP API with SSE streaming.

Source and issues: [heddle-run/heddle](https://github.com/heddle-run/heddle).
MIT licensed.
