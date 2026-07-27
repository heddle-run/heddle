"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "./Editor";
import Tabs from "./Tabs";
import CodeList from "./CodeList";
import RunLog from "./RunLog";
import { Badge, Button, Icon, WindowChrome } from "@/ds";
import {
  API_BASE,
  DEFAULT_EXAMPLE,
  EXAMPLES,
  EngineError,
  appendEvent,
  fetchCapabilities,
  streamRun,
  validateFlow,
  type Capabilities,
  type Example,
  type RequestPlugin,
  type RequestTool,
  type RunEvent,
} from "@/lib/playground";

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
  const [plugins, setPlugins] = useState<RequestPlugin[]>(
    DEFAULT_EXAMPLE.plugins,
  );

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
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
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
        setEvents((previous) => appendEvent(previous, event));

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

  const statusTone: Record<Status, string> = {
    idle: "var(--text-faint)",
    running: "var(--brand-pink)",
    done: "var(--hue-emerald)",
    error: "var(--hue-red)",
  };

  return (
    <div className="hd-container" style={{ paddingBottom: "var(--space-10)" }}>
      {/* The playground is heddle's builder window — the design system's
          floating, blurred, chrome-topped panel is exactly the right frame. */}
      <WindowChrome>
        <EngineBar
          capabilities={capabilities}
          reachable={reachable}
          codeAllowed={codeAllowed}
        />

        <ExamplePicker current={example} onSelect={load} disabled={busy} />

        <div className="hd-split" style={{ gap: 0, alignItems: "stretch" }}>
          {/* --- Editors ------------------------------------------------- */}
          <section
            aria-label="Specification"
            style={{
              display: "flex",
              minWidth: 0,
              flexDirection: "column",
              borderTop: "1px solid var(--border-hairline)",
              borderRight: "1px solid var(--border-hairline)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "stretch",
                justifyContent: "space-between",
                borderBottom: "1px solid var(--border-hairline)",
              }}
            >
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
                style={{
                  display: "flex",
                  minHeight: 44,
                  width: 44,
                  flexShrink: 0,
                  alignItems: "center",
                  justifyContent: "center",
                  border: 0,
                  borderLeft: "1px solid var(--border-hairline)",
                  background: "transparent",
                  color: "var(--text-faint)",
                  cursor: "pointer",
                }}
              >
                <Icon name="rotate-ccw" size={14} />
                <span className="sr-only">Restore example</span>
              </button>
            </div>

            <div style={{ minWidth: 0, flex: 1 }}>
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

            <div
              style={{
                display: "flex",
                gap: "var(--space-3)",
                padding: "var(--space-4)",
                borderTop: "1px solid var(--border-hairline)",
                background: "var(--surface-subtle)",
              }}
            >
              <Button
                shape="rounded"
                variant={busy ? "accent" : "solid"}
                icon={busy ? "square" : "play"}
                onClick={busy ? stop : run}
                style={{ flex: 1 }}
              >
                {busy ? "Stop" : "Run"}
              </Button>
              <Button
                shape="rounded"
                variant="subtle"
                icon="check-check"
                onClick={check}
                disabled={busy}
                style={{ flex: 1 }}
              >
                Validate
              </Button>
            </div>
          </section>

          {/* --- Run log ------------------------------------------------- */}
          <section
            aria-label="Run"
            style={{
              display: "flex",
              minWidth: 0,
              flexDirection: "column",
              borderTop: "1px solid var(--border-hairline)",
            }}
          >
            <div
              style={{
                display: "flex",
                minHeight: 44,
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0 var(--space-5)",
                borderBottom: "1px solid var(--border-hairline)",
              }}
            >
              <span className="hd-eyebrow">Run</span>
              <span
                aria-live="polite"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-2xs)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-widest)",
                  color: statusTone[status],
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "currentColor",
                  }}
                />
                {
                  {
                    idle: "ready",
                    running: "running",
                    done: "complete",
                    error: "failed",
                  }[status]
                }
              </span>
            </div>

            <div style={{ minHeight: "24rem", flex: 1 }}>
              <RunLog
                events={events}
                status={status}
                result={result}
                error={error}
              />
            </div>
          </section>
        </div>
      </WindowChrome>
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
        <code style={{ fontFamily: "var(--font-mono)" }}>
          NEXT_PUBLIC_HEDDLE_API
        </code>{" "}
        to a running{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>heddle-server</code>{" "}
        and rebuild, or run one locally and point the site at it.
      </Notice>
    );
  }

  if (reachable === false) {
    return (
      <Notice>
        The engine at{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>{API_BASE}</code> is
        not answering. It may be down, or it may not list this site as an
        allowed origin.
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
    <dl
      style={{
        display: "flex",
        flexWrap: "wrap",
        margin: 0,
        padding: "var(--space-3) var(--space-5)",
        gap: "var(--space-2) var(--space-6)",
        borderBottom: "1px solid var(--border-hairline)",
        background: "var(--surface-subtle)",
      }}
    >
      {facts.map(([term, value]) => (
        <div
          key={term}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          <dt className="hd-eyebrow">{term}</dt>
          <dd
            style={{
              margin: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-xs)",
              fontVariantNumeric: "tabular-nums",
              color: "var(--text-strong)",
            }}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        display: "flex",
        gap: "var(--space-3)",
        margin: 0,
        padding: "var(--space-4) var(--space-5)",
        borderBottom: "1px solid var(--brand-pink-20)",
        background: "var(--brand-pink-05)",
        fontSize: "var(--fs-sm)",
        lineHeight: "var(--lh-relaxed)",
        color: "var(--text-body)",
      }}
    >
      {children}
    </p>
  );
}

/**
 * Switches between the worked examples.
 *
 * A row of cards rather than a <select>: the choice is the first thing on the
 * page that does anything, and a native dropdown hides three of four options
 * behind a click. Each card carries its own one-line description, so what an
 * example demonstrates is readable without loading it. The selected card takes
 * the design system's 2px accent edge.
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
      className="hd-grid hd-grid-4"
      style={{
        gap: "var(--space-3)",
        padding: "var(--space-4) var(--space-5)",
      }}
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
            style={{
              display: "flex",
              minHeight: 44,
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "var(--space-2)",
              // The 2px selected edge would shift the card by 1px; the padding
              // gives that pixel back.
              padding: active ? "calc(var(--space-4) - 1px)" : "var(--space-4)",
              textAlign: "left",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.4 : 1,
              borderRadius: "var(--radius-lg)",
              background: active
                ? "var(--brand-pink-05)"
                : "var(--surface-subtle)",
              border: active
                ? "2px solid var(--brand-pink-50)"
                : "1px solid var(--border-default)",
              transition:
                "border-color var(--dur-base) var(--ease-standard), background-color var(--dur-base) var(--ease-standard)",
            }}
          >
            <span
              style={{
                display: "flex",
                width: "100%",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: "var(--space-3)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--fs-xs)",
                  fontWeight: "var(--fw-semibold)",
                  textTransform: "uppercase",
                  letterSpacing: "var(--tracking-widest)",
                  color: active ? "var(--brand-pink)" : "var(--text-strong)",
                }}
              >
                {example.title}
              </span>
              {example.needsKey && (
                <Badge tone="neutral" uppercase title="Needs your own model credential">
                  key
                </Badge>
              )}
            </span>
            <span
              style={{
                fontSize: "var(--fs-xs)",
                lineHeight: "var(--lh-relaxed)",
                color: "var(--text-muted)",
              }}
            >
              {example.blurb}
            </span>
          </button>
        );
      })}
    </div>
  );
}
