/**
 * The `encoder` kind — a plugin rendering the run for the client that asked.
 *
 * The kind sits outside the taxonomy every other one belongs to, and three of
 * its properties follow from that rather than from anything about plugins:
 *
 * **Nobody names it in a document.** A spec that writes an encoder's component
 * type is refused, saying so, because two clients hitting one flow can want
 * different renderings and the flow's author is not the party who knows which.
 * Middleware is refused for the mirror-image reason — the operator installs it —
 * and both refusals are here because the two kinds are the only ones a spec
 * cannot reach.
 *
 * **A plugin cannot answer for heddle's own protocol.** `?protocol=heddle` is a
 * client asking for the frames heddle documents; answering with a stranger's
 * rendering is a capture rather than an extension. `claimProtocol` refuses the
 * registration and `resolveEncoder` matches the builtin name before consulting
 * the registry, and both halves are pinned because either alone would be a rule
 * that holds until someone reorders something.
 *
 * **Order is the engine's order.** `EventHandler` is synchronous and an
 * out-of-process encoder answers over a pipe, so everything downstream depends
 * on `EncoderStream` keeping one loop and awaiting each call. Most of the
 * failures worth having here are ordering failures.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// packages/core/src/plugin/__tests__ -> plugin -> src -> core -> packages -> root
const repoRoot = join(import.meta.dirname, '../../../../../');

import { PluginRegistry } from '../registry.js';
import { loadRemotePlugin } from '../remote-loader.js';
import { validateManifest } from '../manifest.js';
import { withRuntime } from '../runtime-source.js';
import { checkPluginComponents } from '../flow-preprocess.js';
import { readWireFrames } from '../protocol.js';
import {
  builtinEncoder,
  BUILTIN_PROTOCOL,
  EncoderStream,
  serializeEvent,
} from '../encoder.js';
import { State } from '../../state/state.js';
import type { Event } from '../../runner/events.js';
import type { HeddlePlugin, PluginEncoder, WireFrame } from '../types.js';

let scratch: string;
const open: PluginRegistry[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-encoder-'));
});

afterEach(() => {
  while (open.length) open.pop()!.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/** An encoder that records what it was asked and renders one frame per event. */
function recorder(): { encoder: PluginEncoder; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    encoder: {
      encode: (event) => {
        seen.push(event.type);
        return [{ data: { saw: event.type } }];
      },
      finish: () => [{ data: { done: true } }],
    },
  };
}

/** Collects frames in the order they were written. */
function frames(): { write: (f: WireFrame) => void; all: WireFrame[] } {
  const all: WireFrame[] = [];
  return { all, write: (f) => all.push(f) };
}

// ---------------------------------------------------------------------------
// heddle's own frames, as one encoder among possibly several.
// ---------------------------------------------------------------------------

describe('the builtin encoder', () => {
  it('renders an event exactly as the wire form always did', () => {
    const event: Event = { type: 'token_delta', nodeName: 'assistant', delta: 'the ' };

    expect(builtinEncoder().encode(event)).toEqual([
      { event: 'token_delta', data: { type: 'token_delta', nodeName: 'assistant', delta: 'the ' } },
    ]);
  });

  it('names every frame, because the type is what a browser subscribes to', () => {
    const [frame] = builtinEncoder().encode({ type: 'flow_complete' }) as WireFrame[];

    expect(frame.event).toBe('flow_complete');
  });

  it('has nothing to say at the end, because the engine already said it', () => {
    // `flow_complete` is a runner event, so a client watching these frames
    // learns the run is over from the engine rather than from the encoder. An
    // encoder for a protocol with its own terminal event does not have that.
    expect(builtinEncoder().finish()).toEqual([]);
  });

  it('turns the two things JSON cannot carry into things it can', () => {
    const wire = serializeEvent({
      type: 'node_complete',
      state: new State({ result: 41 }),
      error: new Error('it broke'),
    });

    expect(wire.state).toEqual({ result: 41 });
    expect(wire.error).toEqual({ name: 'Error', message: 'it broke' });
  });
});

// ---------------------------------------------------------------------------
// The drain: a synchronous engine feeding an asynchronous encoder.
// ---------------------------------------------------------------------------

describe('driving an encoder from the engine', () => {
  it('renders every event the engine offered, in the engine\'s order', async () => {
    const out = frames();
    const { encoder, seen } = recorder();
    const stream = new EncoderStream(encoder, out.write);

    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'node_start', nodeName: 'a' });
    handler({ type: 'node_complete', nodeName: 'a' });
    await stream.close();

    expect(seen).toEqual(['flow_start', 'node_start', 'node_complete']);
    expect(out.all).toEqual([
      { data: { saw: 'flow_start' } },
      { data: { saw: 'node_start' } },
      { data: { saw: 'node_complete' } },
      { data: { done: true } },
    ]);
  });

  it('keeps order when the encoder answers at different speeds', async () => {
    // The property the whole class exists for. A remote encoder's round trips
    // take however long they take, and an implementation that called `encode`
    // per event without a queue would have several in flight at once — so two
    // frames whose relative order a protocol depends on would be decided by
    // which reply came back first.
    const out = frames();
    const delays: Record<string, number> = { flow_start: 30, node_start: 1, node_complete: 10 };
    const stream = new EncoderStream(
      {
        encode: async (event) => {
          await new Promise((r) => setTimeout(r, delays[event.type] ?? 0));
          return [{ data: event.type }];
        },
        finish: () => [],
      },
      out.write,
    );

    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'node_start' });
    handler({ type: 'node_complete' });
    await stream.close();

    expect(out.all.map((f) => f.data)).toEqual(['flow_start', 'node_start', 'node_complete']);
  });

  it('flushes the encoder\'s trailing frames after the last event', async () => {
    const out = frames();
    const stream = new EncoderStream(
      {
        encode: () => [{ data: 'event' }],
        finish: () => [{ data: 'terminal' }],
      },
      out.write,
    );

    stream.offer({ type: 'flow_complete' });
    await stream.close();

    // Last, and only once the backlog is gone: a protocol's terminal frame that
    // overtook the events before it would be a lie about what the run did.
    expect(out.all.map((f) => f.data)).toEqual(['event', 'terminal']);
  });

  it('finishes a run that emitted nothing at all', async () => {
    const out = frames();
    const stream = new EncoderStream(
      { encode: () => [], finish: () => [{ data: 'terminal' }] },
      out.write,
    );

    await stream.close();

    // The aborted-before-anything-ran case. A client waiting for a terminal
    // frame gets one, rather than a stream that opens and closes in silence.
    expect(out.all.map((f) => f.data)).toEqual(['terminal']);
  });

  it('closes once however many times it is called', async () => {
    let finished = 0;
    const stream = new EncoderStream(
      {
        encode: () => [],
        finish: () => {
          finished++;
          return [];
        },
      },
      () => {},
    );

    // The paths that have to call this — a run that returned, one that threw,
    // one whose caller hung up — are not mutually exclusive.
    await stream.close();
    await stream.close();

    expect(finished).toBe(1);
  });

  it('reports the encoder\'s failure to its caller', async () => {
    const stream = new EncoderStream(
      {
        encode: () => {
          throw new Error('cannot render that');
        },
        finish: () => [],
      },
      () => {},
    );

    stream.offer({ type: 'flow_start' });

    await expect(stream.close()).rejects.toThrow('cannot render that');
  });

  it('says so once, and stops rendering, however many events follow', async () => {
    const out = frames();
    const failures: string[] = [];
    let calls = 0;
    const stream = new EncoderStream(
      {
        encode: () => {
          calls++;
          throw new Error('broken');
        },
        finish: () => [{ data: 'terminal' }],
      },
      out.write,
      (err) => failures.push(err.message),
    );

    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'node_start' });
    handler({ type: 'node_complete' });
    await expect(stream.close()).rejects.toThrow('broken');

    // One failure, one call, nothing written. An encoder that throws on every
    // event would otherwise report the same broken rendering once per event, on
    // a stream nobody can read anyway — and `finish` is not asked either, since
    // a failed encoder has no terminal frame worth having.
    expect(calls).toBe(1);
    expect(failures).toEqual(['broken']);
    expect(out.all).toEqual([]);
  });

  it('reports a failure that happens only at the end', async () => {
    const out = frames();
    const failures: string[] = [];
    const stream = new EncoderStream(
      {
        encode: () => [{ data: 'event' }],
        finish: () => {
          throw new Error('nothing left to say');
        },
      },
      out.write,
      (err) => failures.push(err.message),
    );

    stream.offer({ type: 'flow_complete' });
    await expect(stream.close()).rejects.toThrow('nothing left to say');

    // What it did render still went out: the events were rendered correctly and
    // only the terminal frame was not.
    expect(out.all.map((f) => f.data)).toEqual(['event']);
    expect(failures).toEqual(['nothing left to say']);
  });

  it('never throws at the engine, whatever the encoder does', () => {
    const stream = new EncoderStream(
      {
        encode: () => {
          throw new Error('broken');
        },
        finish: () => [],
      },
      () => {},
    );

    // The engine is not the encoder's caller and must not learn about it. A
    // throw from `offer` would surface inside `Runner.emit`, mid-node, and fail
    // a run for a fault in its rendering.
    expect(() => stream.handler()({ type: 'flow_start' })).not.toThrow();
    void stream.close().catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// In process: registration, and the namespace a protocol name lives in.
// ---------------------------------------------------------------------------

/** An in-process plugin providing one encoder. */
function encoderPlugin(
  protocol: string,
  overrides: Partial<HeddlePlugin['encoders'] extends (infer T)[] | undefined ? T : never> = {},
): HeddlePlugin {
  return {
    name: 'ag-ui-plugin',
    version: '1.0.0',
    encoders: [
      {
        componentType: 'AgUiEncoder',
        protocol,
        contentType: 'text/event-stream',
        createEncoder: () => recorder().encoder,
        ...overrides,
      },
    ],
  };
}

describe('an encoder a plugin provides', () => {
  it('is found by the protocol a client asks for', () => {
    const registry = PluginRegistry.fromPlugins([encoderPlugin('ag-ui')]);

    const def = registry.encoderDef('ag-ui');
    expect(def?.componentType).toBe('AgUiEncoder');
    expect(def?.contentType).toBe('text/event-stream');
  });

  it('is not found by its component type, which is a different namespace', () => {
    const registry = PluginRegistry.fromPlugins([encoderPlugin('ag-ui')]);

    // The component type is how the plugin's own handler table dispatches; the
    // protocol is what a client types. A lookup that accepted either would make
    // `AgUiEncoder` a public wire name nobody chose to publish.
    expect(registry.encoderDef('AgUiEncoder')).toBeUndefined();
  });

  it('lists what it renders, without heddle\'s own name', () => {
    const registry = PluginRegistry.fromPlugins([encoderPlugin('ag-ui')]);

    // The caller assembling the answer for a client is the one that knows the
    // builtin exists; this reports only what plugins added.
    expect(registry.encoderProtocols()).toEqual(['ag-ui']);
  });

  it('is not offered to a spec author as a type they may write', () => {
    const registry = PluginRegistry.fromPlugins([encoderPlugin('ag-ui')]);

    // This list is what the parser suggests to somebody who named a type nothing
    // provides. An encoder in it would send them to write a `component_type` the
    // deserializer refuses.
    expect(registry.componentTypeNames()).toEqual([]);
    expect(registry.kindOf('AgUiEncoder')).toBe('encoder');
  });
});

describe('what an encoder may not take', () => {
  it('refuses a plugin that answers for heddle\'s own protocol', () => {
    // The anti-capture rule, at load. A client asking for `heddle` is asking for
    // the frames heddle documents, and a browser written against `flow_complete`
    // is switching on them.
    expect(() =>
      PluginRegistry.fromPlugins([encoderPlugin(BUILTIN_PROTOCOL)]),
    ).toThrow(/heddle's own wire format/);
  });

  it('refuses a protocol name a client could not put in a URL', () => {
    expect(() => PluginRegistry.fromPlugins([encoderPlugin('AG UI!')])).toThrow(
      /protocol=/,
    );
  });

  it('refuses an encoder that does not say what it produces', () => {
    expect(() =>
      PluginRegistry.fromPlugins([
        encoderPlugin('ag-ui', { contentType: '' as string }),
      ]),
    ).toThrow(/contentType/);
  });

  it('refuses two plugins rendering one protocol, naming both', () => {
    const second: HeddlePlugin = {
      ...encoderPlugin('ag-ui'),
      name: 'other-ag-ui',
      encoders: [
        {
          componentType: 'OtherEncoder',
          protocol: 'ag-ui',
          contentType: 'text/event-stream',
          createEncoder: () => recorder().encoder,
        },
      ],
    };

    // Load order is `--plugin` order, and nothing about typing two flags says
    // which of two AG-UI implementations a client meant.
    expect(() => PluginRegistry.fromPlugins([encoderPlugin('ag-ui'), second])).toThrow(
      /both render the protocol "ag-ui"/,
    );
  });

  it('refuses a component type another kind in the same plugin already took', () => {
    const clashing: HeddlePlugin = {
      name: 'clashing',
      version: '1.0.0',
      nodes: [
        {
          componentType: 'AgUiEncoder',
          createExecutor: () => ({ execute: () => ({ output: {} }) }),
        },
      ],
      encoders: [
        {
          componentType: 'AgUiEncoder',
          protocol: 'ag-ui',
          contentType: 'text/event-stream',
          createEncoder: () => recorder().encoder,
        },
      ],
    };

    expect(() => PluginRegistry.fromPlugins([clashing])).toThrow(
      /provided by more than one plugin|AgUiEncoder/,
    );
  });

  it('refuses a spec that names an encoder as a component', () => {
    const registry = PluginRegistry.fromPlugins([encoderPlugin('ag-ui')]);

    expect(() =>
      checkPluginComponents(
        { nodes: [{ component_type: 'AgUiEncoder', name: 'render' }] },
        registry,
      ),
    ).toThrow(/is an encoder.*chosen by the request/s);
  });
});

// ---------------------------------------------------------------------------
// The manifest half.
// ---------------------------------------------------------------------------

describe('a manifest declaring an encoder', () => {
  const manifest = (component: Record<string, unknown>) => () =>
    validateManifest({
      name: 'p',
      version: '1.0.0',
      components: [{ componentType: 'X', kind: 'encoder', ...component }],
    });

  it('accepts one that says what it renders and what it produces', () => {
    const read = manifest({ protocol: 'ag-ui', contentType: 'text/event-stream' })();

    expect(read.components[0].protocol).toBe('ag-ui');
    expect(read.components[0].contentType).toBe('text/event-stream');
  });

  it('lists encoder among the kinds it will accept', () => {
    expect(() =>
      validateManifest({
        name: 'p',
        version: '1.0.0',
        components: [{ componentType: 'X', kind: 'encdoer' }],
      }),
    ).toThrow(/expected node, transform, component, provider, middleware or encoder/);
  });

  it('refuses an encoder with no protocol, which nothing could select', () => {
    expect(manifest({ contentType: 'text/event-stream' })).toThrow(/needs a "protocol"/);
  });

  it('refuses an encoder with no contentType, which has no header to send', () => {
    expect(manifest({ protocol: 'ag-ui' })).toThrow(/needs a "contentType"/);
  });

  it('refuses a protocol name that is not URL-safe', () => {
    expect(manifest({ protocol: 'AG UI', contentType: 'text/event-stream' })).toThrow(
      /"protocol"/,
    );
  });

  it('refuses a protocol on a kind that is not an encoder', () => {
    // The same treatment `seams` gets on a node: a field that silently did
    // nothing would leave an author believing their format was selectable.
    expect(() =>
      validateManifest({
        name: 'p',
        version: '1.0.0',
        components: [{ componentType: 'X', kind: 'node', protocol: 'ag-ui' }],
      }),
    ).toThrow(/declares "protocol" but its kind is "node"/);
  });

  it('refuses a contentType on a kind that is not an encoder', () => {
    expect(() =>
      validateManifest({
        name: 'p',
        version: '1.0.0',
        components: [{ componentType: 'X', kind: 'transform', contentType: 'text/plain' }],
      }),
    ).toThrow(/declares "contentType" but its kind is "transform"/);
  });
});

// ---------------------------------------------------------------------------
// What comes back over a pipe, and what is refused before it reaches a client.
// ---------------------------------------------------------------------------

describe('reading the frames an encoder returned', () => {
  it('accepts an empty list, which is what most events deserve', () => {
    expect(readWireFrames([], 'enc')).toEqual([]);
  });

  it('accepts a nameless frame, which is what AG-UI needs', () => {
    expect(readWireFrames([{ data: { type: 'RUN_STARTED' } }], 'enc')).toEqual([
      { data: { type: 'RUN_STARTED' } },
    ]);
  });

  it('keeps a frame\'s name when it has one', () => {
    expect(readWireFrames([{ event: 'node_start', data: 1 }], 'enc')).toEqual([
      { event: 'node_start', data: 1 },
    ]);
  });

  it('refuses anything that is not a list of frames', () => {
    expect(() => readWireFrames({ data: 1 }, 'enc')).toThrow(/expected an array of frames/);
    expect(() => readWireFrames(undefined, 'enc')).toThrow(/expected an array of frames/);
  });

  it('refuses a frame carrying nothing, which would reach a client as undefined', () => {
    expect(() => readWireFrames([{ event: 'x' }], 'enc')).toThrow(/no "data"/);
  });

  it('refuses a frame name that is not a string', () => {
    expect(() => readWireFrames([{ event: 7, data: 1 }], 'enc')).toThrow(/expected a string/);
  });

  it('refuses a frame name that would write a frame of its own', () => {
    // The forgery `SseStream.send` strips at the wire, refused here instead —
    // because here there is a call to fail and an author to tell, and silently
    // rewriting the name would produce a rendering the plugin did not write.
    expect(() =>
      readWireFrames([{ event: 'a\n\ndata: {}', data: 1 }], 'enc'),
    ).toThrow(/contains a newline/);
  });
});

// ---------------------------------------------------------------------------
// Out of process, where a rendering is a frame on a pipe.
// ---------------------------------------------------------------------------

function writeHelperPlugin(name: string, source: string): string {
  const entry = join(scratch, `${name}.mjs`);
  writeFileSync(entry, withRuntime(source));
  return entry;
}

function encoderManifest() {
  return {
    name: 'remote-encoder',
    version: '1.0.0',
    // Nothing. An encoder asks the host for no tool, no model and no workspace,
    // so it is the one kind that is complete with an empty grant.
    capabilities: [],
    components: [
      {
        componentType: 'AgUiEncoder',
        kind: 'encoder',
        protocol: 'ag-ui',
        contentType: 'text/event-stream',
      },
    ],
  };
}

function remoteRegistry(entry: string): PluginRegistry {
  const registry = PluginRegistry.empty();
  registry.addRemote(loadRemotePlugin(encoderManifest(), entry, { timeout: 5000 }));
  open.push(registry);
  return registry;
}

/**
 * The encoder the repository ships, loaded from disk and running in its own
 * process — the same path a submitted plugin takes.
 *
 * Read rather than reimplemented, for `examples/guardrails`'s reason: a copy
 * would pass while the shipped one was broken, and this example is the reference
 * a plugin author copies.
 */
async function shippedEncoder(label: string, runId: string): Promise<PluginEncoder> {
  const source = readFileSync(join(repoRoot, 'examples/ag-ui/encoder.mjs'), 'utf-8');
  const manifest = JSON.parse(
    readFileSync(join(repoRoot, 'examples/ag-ui/manifest.json'), 'utf-8'),
  );
  const entry = writeHelperPlugin(`shipped-${label}`, source);

  const registry = PluginRegistry.empty();
  registry.addRemote(loadRemotePlugin(manifest, entry, { timeout: 5000 }));
  open.push(registry);

  return registry.encoderDef('ag-ui')!.createEncoder(runId);
}

describe('an encoder in its own process', () => {
  it('renders events and finishes the run', async () => {
    const entry = writeHelperPlugin(
      'ag-ui',
      `serve({ AgUiEncoder: {
         encode: (event, ctx) => event.type === 'token_delta'
           ? [{ data: { type: 'TEXT_MESSAGE_CONTENT', messageId: event.nodeName,
                        delta: event.delta, run: ctx.runId } }]
           : [],
         finish: (ctx) => [{ data: { type: 'RUN_FINISHED', runId: ctx.runId } }],
       } });`,
    );

    const def = remoteRegistry(entry).encoderDef('ag-ui')!;
    const out = frames();
    const stream = new EncoderStream(def.createEncoder('run-7'), out.write);

    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'token_delta', nodeName: 'assistant', delta: 'the ' });
    await stream.close();

    // `flow_start` produced nothing, which is the ordinary answer for an event a
    // format does not render — and the runId reached the plugin on both verbs.
    expect(out.all).toEqual([
      {
        data: {
          type: 'TEXT_MESSAGE_CONTENT',
          messageId: 'assistant',
          delta: 'the ',
          run: 'run-7',
        },
      },
      { data: { type: 'RUN_FINISHED', runId: 'run-7' } },
    ]);
  });

  it('is handed the event in the same shape heddle\'s own frames carry', async () => {
    const entry = writeHelperPlugin(
      'echo',
      `serve({ AgUiEncoder: {
         encode: (event) => [{ data: event }],
         finish: () => [],
       } });`,
    );

    const def = remoteRegistry(entry).encoderDef('ag-ui')!;
    const out = frames();
    const stream = new EncoderStream(def.createEncoder('r'), out.write);

    stream.offer({
      type: 'node_complete',
      nodeName: 'a',
      attempt: 2,
      state: new State({ result: 41 }),
    });
    await stream.close();

    // What a plugin encoder reads is what a browser watching ?protocol=heddle
    // reads — `serializeEvent`'s output, `State` already flattened. A second
    // event shape defined only for plugins would have to be kept in step with
    // this one, and would drift the day a field was added to either.
    expect(out.all[0].data).toEqual({
      type: 'node_complete',
      nodeName: 'a',
      attempt: 2,
      state: { result: 41 },
    });
  });

  it('fails the rendering when the plugin serves no encode handler', async () => {
    const entry = writeHelperPlugin(
      'nohandler',
      `serve({ AgUiEncoder: { finish: () => [] } });`,
    );

    const def = remoteRegistry(entry).encoderDef('ag-ui')!;
    const stream = new EncoderStream(def.createEncoder('r'), () => {});

    stream.offer({ type: 'flow_start' });

    await expect(stream.close()).rejects.toThrow(/serves no encode handler/);
  });

  it('fails the rendering when the plugin returns something that is not frames', async () => {
    const entry = writeHelperPlugin(
      'notframes',
      `serve({ AgUiEncoder: {
         encode: () => ({ type: 'RUN_STARTED' }),
         finish: () => [],
       } });`,
    );

    const def = remoteRegistry(entry).encoderDef('ag-ui')!;
    const stream = new EncoderStream(def.createEncoder('r'), () => {});

    stream.offer({ type: 'flow_start' });

    // A protocol object where a list of frames was expected. Caught before it
    // reaches the transport, and named as the encoder's fault rather than
    // arriving as a malformed frame.
    await expect(stream.close()).rejects.toThrow(/expected an array of frames/);
  });

  it('renders a real run through the shipped AG-UI example', async () => {
    // The example is a live consumer, in the same way `examples/guardrails` is:
    // shipped in the repository, loaded from disk here, and rendered against the
    // real event sequence a flow produces. A change that breaks it fails CI
    // rather than being found by whoever reads the README.
    const out = frames();
    const stream = new EncoderStream(await shippedEncoder('happy', 'run-1'), out.write);

    // The sequence a one-node flow with a streaming agent actually emits.
    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'node_start', nodeName: 'assistant', attempt: 1 });
    handler({ type: 'token_delta', nodeName: 'assistant', attempt: 1, delta: 'the ' });
    handler({ type: 'token_delta', nodeName: 'assistant', attempt: 1, delta: 'answer' });
    handler({ type: 'node_complete', nodeName: 'assistant', attempt: 1 });
    handler({ type: 'flow_complete' });
    await stream.close();

    const types = out.all.map((f) => (f.data as { type: string }).type);
    // The framing AG-UI requires and heddle does not emit: one START before the
    // deltas, one END after them, opened by the first delta and closed by the
    // node completing.
    expect(types).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'STEP_FINISHED',
      'RUN_FINISHED',
    ]);

    // Every frame nameless, with its type inside — which is what makes this
    // AG-UI rather than heddle's frames wearing AG-UI names.
    expect(out.all.every((f) => f.event === undefined)).toBe(true);

    // The required fields, spelled as the protocol's own schema spells them.
    expect(out.all[0].data).toEqual({
      type: 'RUN_STARTED',
      threadId: 'run-1',
      runId: 'run-1',
    });
    expect(out.all[3].data).toEqual({
      type: 'TEXT_MESSAGE_CONTENT',
      messageId: 'assistant#1',
      delta: 'the ',
    });
    // `RUN_FINISHED` carries threadId and runId, both required by the schema and
    // both absent from the prose documentation's table for it.
    expect(out.all[7].data).toEqual({
      type: 'RUN_FINISHED',
      threadId: 'run-1',
      runId: 'run-1',
    });
  });

  it('ends the shipped example\'s rendering with RUN_ERROR when a run fails', async () => {
    const out = frames();
    const stream = new EncoderStream(await shippedEncoder('fail', 'run-2'), out.write);

    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'node_start', nodeName: 'a', attempt: 1 });
    handler({ type: 'token_delta', nodeName: 'a', attempt: 1, delta: 'half an ' });
    handler({ type: 'node_error', nodeName: 'a', attempt: 1, error: new Error('it broke') });
    await stream.close();

    const types = out.all.map((f) => (f.data as { type: string }).type);
    // `node_error` renders no *run*-terminal frame of its own, because since
    // middleware landed a node error is not terminal — a retry can follow it.
    // What it does close is the message the deltas opened and the step the
    // `node_start` opened, so a client is left with neither unterminated.
    expect(types).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'STEP_FINISHED',
      'RUN_ERROR',
    ]);
    // And the outcome was read off the stream — no `flow_complete` arrived, so
    // the run did not succeed — carrying the node's own message.
    expect(out.all[6].data).toMatchObject({ type: 'RUN_ERROR', message: 'it broke' });
  });

  it('opens no second step for a node a middleware retried', async () => {
    // The sequence a `nodeError` middleware granting a retry produces: one node
    // entered twice, with no `node_complete` for the failed attempt. AG-UI
    // refuses a `STEP_STARTED` for a step that is already active — its client
    // runs that check unconditionally — so a step left open by the error would
    // make the client abort the run at the retry and discard every frame after
    // it, including the terminal one.
    const out = frames();
    const stream = new EncoderStream(await shippedEncoder('retry', 'run-3'), out.write);

    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'node_start', nodeName: 'a', attempt: 1 });
    handler({ type: 'node_error', nodeName: 'a', attempt: 1, error: new Error('flaky') });
    handler({ type: 'warning', nodeName: 'a', message: 'retrying "a" after it failed' });
    handler({ type: 'node_start', nodeName: 'a', attempt: 2 });
    handler({ type: 'node_complete', nodeName: 'a', attempt: 2 });
    handler({ type: 'flow_complete' });
    await stream.close();

    const types = out.all.map((f) => (f.data as { type: string }).type);
    expect(types).toEqual([
      'RUN_STARTED',
      'STEP_STARTED',
      'STEP_FINISHED', // the failed attempt's step closes, though the run continues
      'CUSTOM', // the retry warning, which AG-UI has no lifecycle event for
      'STEP_STARTED',
      'STEP_FINISHED',
      'RUN_FINISHED',
    ]);

    // Every STEP_STARTED closed before the next one opened, which is the rule
    // the client enforces.
    let open_ = 0;
    for (const type of types) {
      if (type === 'STEP_STARTED') open_++;
      if (type === 'STEP_FINISHED') open_--;
      expect(open_).toBeLessThanOrEqual(1);
    }
    expect(open_).toBe(0);
  });

  it('gives every message the shipped example mints an identity of its own', async () => {
    // Three things share one node in AG-UI's model — the assistant message, and
    // one tool message per call — and a client keys its message list by id, so a
    // collision silently keeps one of them. heddle supplies no message ids at
    // all, which makes minting them the encoder's job and this the place it can
    // go wrong without anything failing.
    const out = frames();
    const stream = new EncoderStream(await shippedEncoder('ids', 'run-4'), out.write);

    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'node_start', nodeName: 'researcher', attempt: 1 });
    handler({ type: 'token_delta', nodeName: 'researcher', delta: 'looking' });
    handler({
      type: 'tool_call',
      nodeName: 'researcher',
      toolName: 'fetch',
      toolCallId: 'call_1',
      toolArgs: { url: 'x' },
    });
    handler({
      type: 'tool_result',
      nodeName: 'researcher',
      toolName: 'fetch',
      toolCallId: 'call_1',
      toolResult: { ok: true },
    });
    handler({
      type: 'tool_result',
      nodeName: 'researcher',
      toolName: 'fetch',
      toolCallId: 'call_2',
      error: new Error('HTTP 500 from y'),
    });
    await stream.close();

    const byType = (t: string) =>
      out.all.map((f) => f.data as Record<string, unknown>).filter((d) => d.type === t);

    // The assistant message and both tool messages are distinct.
    const ids = [
      byType('TEXT_MESSAGE_START')[0].messageId,
      ...byType('TOOL_CALL_RESULT').map((d) => d.messageId),
    ];
    expect(new Set(ids).size).toBe(ids.length);

    // The call still points at the assistant message it belongs to.
    expect(byType('TOOL_CALL_START')[0].parentMessageId).toBe(
      byType('TEXT_MESSAGE_START')[0].messageId,
    );

    // A tool that threw is not a tool that returned nothing. heddle emits
    // `tool_result` with an `error` and no `toolResult`, and AG-UI's frame has a
    // required `content` and no error field — so the message goes in `content`,
    // where the model's own copy of it goes, rather than being rendered as a
    // successful `null`.
    const results = byType('TOOL_CALL_RESULT');
    expect(results[0].content).toBe('{"ok":true}');
    expect(results[1].content).toBe('Error: HTTP 500 from y');
  });

  it('keeps a retried node\'s abandoned text out of the message that replaced it', async () => {
    // `attempt` cannot key a message id: it is absent from `token_delta`, and it
    // resets when the flow advances, so a loop revisiting a streaming node
    // collides too. AG-UI's reducer treats a repeated TEXT_MESSAGE_START as a
    // no-op and appends the content, so a reused id does not fail — it silently
    // concatenates two turns into one message.
    const out = frames();
    const stream = new EncoderStream(await shippedEncoder('visits', 'run-5'), out.write);

    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'node_start', nodeName: 'writer', attempt: 1 });
    handler({ type: 'token_delta', nodeName: 'writer', delta: 'Hello' });
    handler({ type: 'node_error', nodeName: 'writer', attempt: 1, error: new Error('flaky') });
    handler({ type: 'node_start', nodeName: 'writer', attempt: 2 });
    handler({ type: 'token_delta', nodeName: 'writer', delta: 'Hi there' });
    handler({ type: 'node_complete', nodeName: 'writer', attempt: 2 });
    await stream.close();

    const starts = out.all
      .map((f) => f.data as Record<string, unknown>)
      .filter((d) => d.type === 'TEXT_MESSAGE_START');

    expect(starts).toHaveLength(2);
    expect(starts[0].messageId).not.toBe(starts[1].messageId);
  });

  it('snapshots the whole run state, not the node\'s own output', async () => {
    // AG-UI's STATE_SNAPSHOT is a whole-state replacement, while
    // `node_complete.state` is only what that node produced — the runner merges
    // it into the run state one line later. Sending the output as a snapshot
    // deletes whatever earlier nodes and the run's inputs put there.
    const out = frames();
    const stream = new EncoderStream(await shippedEncoder('state', 'run-6'), out.write);

    const handler = stream.handler();
    handler({ type: 'flow_start' });
    handler({ type: 'node_start', nodeName: 'draft', state: new State({ query: 'hello' }) });
    // An LlmNode's output carries only what it generated.
    handler({ type: 'node_complete', nodeName: 'draft', state: new State({ generated_text: 'a draft' }) });
    await stream.close();

    const snapshot = out.all
      .map((f) => f.data as Record<string, unknown>)
      .find((d) => d.type === 'STATE_SNAPSHOT');

    expect(snapshot?.snapshot).toEqual({ query: 'hello', generated_text: 'a draft' });
  });

  it('fails the rendering when the plugin dies mid-run', async () => {
    const entry = writeHelperPlugin(
      'dies',
      `serve({ AgUiEncoder: {
         encode: () => { process.exit(1); },
         finish: () => [],
       } });`,
    );

    const def = remoteRegistry(entry).encoderDef('ag-ui')!;
    const stream = new EncoderStream(def.createEncoder('r'), () => {});

    stream.offer({ type: 'flow_start' });

    await expect(stream.close()).rejects.toThrow();
  });
});
