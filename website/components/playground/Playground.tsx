"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Square, CheckCheck, RotateCcw } from "lucide-react";
import Editor from "./Editor";
import Tabs from "./Tabs";
import CodeList from "./CodeList";
import RunLog from "./RunLog";
import {
  API_BASE,
  DEFAULT_EXAMPLE,
  EXAMPLES,
  EngineError,
  fetchCapabilities,
  streamRun,
  validateFlow,
  type Capabilities,
  type Example,
  type RequestPlugin,
  type RequestTool,
  type RunEvent,
} from "@/lib/playground";
import { cn } from "@/lib/cn";

type Status = "idle" | "running" | "done" | "error";

const TOOL_STUB = `read -r input
printf '{"result": "ok"}'
`;

const PLUGIN_STUB = `serve({
  MyNode: {
    execute(input) {
      return { output: { ...input } };
    },
  },
});
`;

/** The manifest a newly added plugin starts from, matching PLUGIN_STUB. */
const PLUGIN_MANIFEST_STUB = {
  name: "my-plugin",
  version: "1.0.0",
  components: [{ componentType: "MyNode" }],
};

export default function Playground() {
  const [example, setExample] = useState<Example>(DEFAULT_EXAMPLE);
  const [flow, setFlow] = useState(DEFAULT_EXAMPLE.flow);
  const [inputs, setInputs] = useState(DEFAULT_EXAMPLE.inputs);
  const [tools, setTools] = useState<RequestTool[]>(DEFAULT_EXAMPLE.tools);
  const [plugins, setPlugins] = useState<RequestPlugin[]>(DEFAULT_EXAMPLE.plugins);

  const [tab, setTab] = useState("flow");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Record<string, unknown>>();
  const [error, setError] = useState<{ type: string; message: string }>();
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [reachable, setReachable] = useState<boolean>();

  const abortRef = useRef<AbortController>(null);

  // Probe the engine once so the page can say what it is talking to, and warn
  // early rather than at the first run if it is unreachable.
  useEffect(() => {
    const ac = new AbortController();
    fetchCapabilities(ac.signal)
      .then((caps) => {
        setCapabilities(caps);
        setReachable(true);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name !== "AbortError") setReachable(false);
      });
    return () => ac.abort();
  }, []);

  /** Read the inputs box, reporting bad JSON without a round trip. */
  const readInputs = useCallback((): Record<string, unknown> => {
    const text = inputs.trim();
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SyntaxError("Inputs must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }, [inputs]);

  const payload = useCallback(
    () => ({ flow, inputs: readInputs(), tools, plugins }),
    [flow, readInputs, tools, plugins],
  );

  const fail = (err: unknown) => {
    if (err instanceof EngineError) {
      setError({ type: err.type, message: err.message });
    } else if (err instanceof SyntaxError) {
      setError({ type: "InvalidInputs", message: err.message });
    } else if ((err as Error)?.name === "AbortError") {
      setError({ type: "Aborted", message: "Run stopped." });
    } else {
      // A fetch that rejects rather than returning a status is almost always
      // the browser refusing the response: the engine is down, or its CORS
      // origins do not include this one.
      setError({
        type: "NetworkError",
        message:
          `Could not reach the engine at ${API_BASE || "(not configured)"}. ` +
          "It may be down, or it may not allow this origin.",
      });
    }
    setStatus("error");
  };

  const reset = () => {
    setEvents([]);
    setResult(undefined);
    setError(undefined);
  };

  const run = async () => {
    reset();
    setStatus("running");

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      for await (const event of streamRun(payload(), ac.signal)) {
        setEvents((previous) => [...previous, event]);

        if (event.type === "flow_complete" && event.state) {
          setResult(event.state);
        }
        if (event.type === "error") {
          setError({
            type: event.error?.type ?? event.error?.name ?? "Error",
            message: event.error?.message ?? "the run failed",
          });
        }
      }
      setStatus((current) => (current === "error" ? current : "done"));
    } catch (err) {
      fail(err);
    } finally {
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const check = async () => {
    reset();
    setStatus("running");
    try {
      const validation = await validateFlow(payload());
      setEvents([
        { type: "flow_start" },
        ...validation.nodes.map((node) => ({
          type: "node_start",
          nodeName: node.name,
          nodeType: node.type,
        })),
        { type: "flow_complete" },
      ]);
      setResult({
        valid: true,
        flow: validation.flow,
        startNode: validation.startNode,
        nodes: validation.nodes.length,
      });
      setStatus("done");
    } catch (err) {
      fail(err);
    }
  };

  /** Load an example, discarding whatever is in the editors. */
  const load = (next: Example) => {
    setExample(next);
    setFlow(next.flow);
    setInputs(next.inputs);
    setTools(next.tools);
    setPlugins(next.plugins);
    setTab("flow");
    reset();
    setStatus("idle");
  };

  const restore = () => load(example);

  const busy = status === "running";
  const codeAllowed = capabilities?.allowRequestCode ?? true;
  const limits = capabilities?.limits;

  return (
    <div className="border-t border-ink">
      <EngineBar
        capabilities={capabilities}
        reachable={reachable}
        codeAllowed={codeAllowed}
      />

      <ExamplePicker current={example} onSelect={load} disabled={busy} />

      <div className="grid border-t border-ink lg:grid-cols-2">
        {/* --- Editors ------------------------------------------------- */}
        <section
          aria-label="Specification"
          className="flex min-w-0 flex-col border-b border-ink lg:border-b-0 lg:border-r"
        >
          <div className="flex items-stretch justify-between border-b border-ink">
            <Tabs
              tabs={[
                { id: "flow", label: "Flow" },
                { id: "inputs", label: "Inputs" },
                { id: "tools", label: "Tools", badge: tools.length },
                { id: "plugins", label: "Plugins", badge: plugins.length },
              ]}
              active={tab}
              onSelect={setTab}
            />
            <button
              type="button"
              onClick={restore}
              title={`Restore the "${example.title}" example`}
              className="flex min-h-[44px] w-11 shrink-0 items-center justify-center border-l border-hairline text-muted-ink transition-colors duration-100 hover:bg-ink hover:text-paper focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink"
            >
              <RotateCcw size={14} strokeWidth={1.5} />
              <span className="sr-only">Restore example</span>
            </button>
          </div>

          <div className="min-w-0 flex-1">
            {tab === "flow" && (
              <Editor
                label="Flow specification"
                value={flow}
                onChange={setFlow}
                rows={30}
                placeholder="An Agent Spec flow, as YAML or JSON"
              />
            )}

            {tab === "inputs" && (
              <Editor
                label="Inputs"
                value={inputs}
                onChange={setInputs}
                rows={12}
                placeholder='{ "query": "..." }'
              />
            )}

            {tab === "tools" && (
              <CodeList
                kind="tool"
                entries={tools}
                onChange={(next) => setTools(next as RequestTool[])}
                limit={limits?.maxRequestTools ?? 10}
                emptySource={TOOL_STUB}
                note="A tool reads its arguments as JSON on stdin and writes JSON on stdout. It runs as a subprocess, inside the engine's sandbox."
              />
            )}

            {tab === "plugins" && (
              <CodeList
                kind="plugin"
                entries={plugins}
                onChange={(next) => setPlugins(next as RequestPlugin[])}
                limit={limits?.maxRequestPlugins ?? 5}
                emptySource={PLUGIN_STUB}
                emptyManifest={PLUGIN_MANIFEST_STUB}
                note="A plugin adds component types the engine does not ship. The manifest declares them as data; the source runs in its own process, so it never sees the engine's memory or environment. Call serve({ ComponentType: { execute } }) — it is supplied for you."
              />
            )}
          </div>

          <div className="flex items-stretch border-t border-ink">
            <button
              type="button"
              onClick={busy ? stop : run}
              className={cn(
                "flex min-h-[56px] flex-1 items-center justify-center gap-3 border-r border-hairline font-mono text-xs uppercase tracking-[0.2em] transition-colors duration-100",
                "focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink",
                "bg-ink text-paper hover:bg-paper hover:text-ink",
              )}
            >
              {busy ? (
                <>
                  <Square size={14} strokeWidth={1.5} /> Stop
                </>
              ) : (
                <>
                  <Play size={14} strokeWidth={1.5} /> Run
                </>
              )}
            </button>

            <button
              type="button"
              onClick={check}
              disabled={busy}
              className="flex min-h-[56px] flex-1 items-center justify-center gap-3 font-mono text-xs uppercase tracking-[0.2em] transition-colors duration-100 hover:bg-ink hover:text-paper focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink disabled:opacity-40 disabled:hover:bg-paper disabled:hover:text-ink"
            >
              <CheckCheck size={14} strokeWidth={1.5} /> Validate
            </button>
          </div>
        </section>

        {/* --- Run log ------------------------------------------------- */}
        <section aria-label="Run" className="flex min-w-0 flex-col">
          <div className="flex min-h-[44px] items-center justify-between border-b border-ink px-5">
            <p className="font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-muted-ink">
              Run
            </p>
            <p
              aria-live="polite"
              className="font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-muted-ink"
            >
              {
                {
                  idle: "ready",
                  running: "running",
                  done: "complete",
                  error: "failed",
                }[status]
              }
            </p>
          </div>

          <div className="min-h-[24rem] flex-1">
            <RunLog
              events={events}
              status={status}
              result={result}
              error={error}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

/** What the page is connected to, stated plainly rather than assumed. */
function EngineBar({
  capabilities,
  reachable,
  codeAllowed,
}: {
  capabilities?: Capabilities;
  reachable?: boolean;
  codeAllowed: boolean;
}) {
  if (!API_BASE) {
    return (
      <Notice>
        No engine is configured for this build. Set{" "}
        <code className="font-mono">NEXT_PUBLIC_HEDDLE_API</code> to a running{" "}
        <code className="font-mono">heddle-server</code> and rebuild, or run one
        locally and point the site at it.
      </Notice>
    );
  }

  if (reachable === false) {
    return (
      <Notice>
        The engine at <code className="font-mono">{API_BASE}</code> is not
        answering. It may be down, or it may not list this site as an allowed
        origin.
      </Notice>
    );
  }

  const facts: [string, string][] = capabilities
    ? [
        ["engine", capabilities.version],
        ["sandbox", capabilities.sandbox ?? "none"],
        ["submitted code", codeAllowed ? "accepted" : "refused"],
        ["timeout", `${Math.round(capabilities.limits.timeout / 1000)}s`],
      ]
    : [["engine", "connecting"]];

  return (
    <dl className="flex flex-wrap items-stretch">
      {facts.map(([term, value]) => (
        <div
          key={term}
          className="flex min-h-[44px] items-center gap-3 border-r border-hairline px-5"
        >
          <dt className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-muted-ink">
            {term}
          </dt>
          <dd className="font-mono text-[0.6875rem] tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="bg-ink px-6 py-4 font-mono text-[0.6875rem] leading-relaxed text-paper md:px-8 lg:px-12">
      {children}
    </p>
  );
}

/**
 * Switches between the worked examples.
 *
 * A row of inverting cells rather than a <select>: the choice is the first
 * thing on the page that does anything, and a native dropdown hides three of
 * four options behind a click. Each cell carries its own one-line description,
 * so what an example demonstrates is readable without loading it.
 */
function ExamplePicker({
  current,
  onSelect,
  disabled,
}: {
  current: Example;
  onSelect: (example: Example) => void;
  disabled: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Examples"
      className="grid border-t border-ink sm:grid-cols-2 lg:grid-cols-4"
    >
      {EXAMPLES.map((example) => {
        const active = example.id === current.id;
        return (
          <button
            key={example.id}
            type="button"
            onClick={() => onSelect(example)}
            disabled={disabled}
            aria-pressed={active}
            className={cn(
              "group flex min-h-[44px] flex-col items-start gap-2 border-b border-r border-ink px-5 py-4 text-left transition-colors duration-100",
              "focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink",
              "disabled:cursor-not-allowed disabled:opacity-40",
              active
                ? "bg-ink text-paper"
                : "bg-paper text-ink hover:bg-ink hover:text-paper",
            )}
          >
            <span className="flex w-full items-baseline justify-between gap-3">
              <span className="font-mono text-[0.6875rem] uppercase tracking-[0.2em]">
                {example.title}
              </span>
              {example.needsKey && (
                <span
                  title="Needs your own model credential"
                  className={cn(
                    "shrink-0 font-mono text-[0.5625rem] uppercase tracking-[0.15em]",
                    active ? "text-paper/60" : "text-muted-ink group-hover:text-paper/60",
                  )}
                >
                  key
                </span>
              )}
            </span>
            <span
              className={cn(
                "text-xs leading-relaxed",
                active ? "text-paper/70" : "text-muted-ink group-hover:text-paper/70",
              )}
            >
              {example.blurb}
            </span>
          </button>
        );
      })}
    </div>
  );
}
