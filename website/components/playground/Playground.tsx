"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "./Editor";
import Tabs from "./Tabs";
import CodeList from "./CodeList";
import RunLog from "./RunLog";
import Wordmark from "../Wordmark";
import { useTheme } from "@/lib/theme";
import { Badge, Button, Icon, Select, ThemeToggle } from "@/ds";
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

const PLUGIN_MANIFEST_STUB = {
  name: "my-plugin",
  version: "1.0.0",
  components: [{ componentType: "MyNode" }],
};

export default function Playground() {
  const { dark, toggle } = useTheme();

  const [example, setExample] = useState<Example>(DEFAULT_EXAMPLE);
  const [flow, setFlow] = useState(DEFAULT_EXAMPLE.flow);
  const [inputs, setInputs] = useState(DEFAULT_EXAMPLE.inputs);
  const [tools, setTools] = useState<RequestTool[]>(DEFAULT_EXAMPLE.tools);
  const [plugins, setPlugins] = useState<RequestPlugin[]>(
    DEFAULT_EXAMPLE.plugins,
  );

  const [tab, setTab] = useState("spec");
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Record<string, unknown>>();
  const [error, setError] = useState<{ type: string; message: string }>();
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [reachable, setReachable] = useState<boolean>();

  const abortRef = useRef<AbortController>(null);

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

  const load = (next: Example) => {
    setExample(next);
    setFlow(next.flow);
    setInputs(next.inputs);
    setTools(next.tools);
    setPlugins(next.plugins);
    setTab("spec");
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
    <div className="hd-playground">
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--space-3) var(--space-5)",
          padding: "var(--space-3) var(--space-5)",
          borderBottom: "1px solid var(--border-hairline)",
          background: "var(--surface-chrome)",
          backdropFilter: "blur(var(--blur-chrome))",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
          }}
        >
          <Link href="/" aria-label="heddle — home">
            <Wordmark size="sm" />
          </Link>
          <span
            aria-hidden
            style={{
              width: 1,
              height: 16,
              background: "var(--border-default)",
            }}
          />
          <span className="hd-eyebrow">Playground</span>
        </div>

        <ExamplePicker current={example} onSelect={load} disabled={busy} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            marginLeft: "auto",
          }}
        >
          <Button
            shape="rounded"
            variant={busy ? "accent" : "solid"}
            icon={busy ? "square" : "play"}
            onClick={busy ? stop : run}
          >
            {busy ? "Stop" : "Run"}
          </Button>
          <Button
            shape="rounded"
            variant="subtle"
            icon="check-check"
            onClick={check}
            disabled={busy}
          >
            Validate
          </Button>
          <ThemeToggle dark={dark} onToggle={toggle} />
        </div>
      </header>

      <EngineNotice reachable={reachable} />

      <div className="hd-playground-body">
        <section
          id="editors"
          tabIndex={-1}
          aria-label="Specification"
          className="hd-playground-pane"
        >
          <div
            style={{
              display: "flex",
              flexShrink: 0,
              alignItems: "stretch",
              justifyContent: "space-between",
              borderBottom: "1px solid var(--border-hairline)",
            }}
          >
            <Tabs
              tabs={[
                { id: "spec", label: "Spec" },
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

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              minHeight: 0,
              flex: 1,
              overflowY: "auto",
            }}
          >
            {tab === "spec" && (
              <Editor
                fill
                label="Spec"
                value={flow}
                onChange={setFlow}
                rows={30}
                placeholder="An Agent Spec document, rooted at a Flow, as YAML or JSON"
              />
            )}

            {tab === "inputs" && (
              <Editor
                fill
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
        </section>

        <section aria-label="Run" className="hd-playground-pane">
          <div
            style={{
              display: "flex",
              minHeight: 44,
              flexShrink: 0,
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

          <div style={{ minHeight: 0, flex: 1 }}>
            <RunLog
              events={events}
              status={status}
              result={result}
              error={error}
            />
          </div>
        </section>
      </div>

      <StatusBar
        capabilities={capabilities}
        reachable={reachable}
        codeAllowed={codeAllowed}
      />
    </div>
  );
}

function EngineNotice({ reachable }: { reachable?: boolean }) {
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

  return null;
}

function StatusBar({
  capabilities,
  reachable,
  codeAllowed,
}: {
  capabilities?: Capabilities;
  reachable?: boolean;
  codeAllowed: boolean;
}) {
  const facts: [string, string][] = !API_BASE
    ? [["engine", "not configured"]]
    : reachable === false
      ? [["engine", "unreachable"]]
      : capabilities
        ? [
            ["engine", capabilities.version],
            ["sandbox", capabilities.sandbox ?? "none"],
            ["submitted code", codeAllowed ? "accepted" : "refused"],
            ["timeout", `${Math.round(capabilities.limits.timeout / 1000)}s`],
          ]
        : [["engine", "connecting"]];

  return (
    <footer
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "var(--space-3) var(--space-8)",
        padding: "var(--space-3) var(--space-5)",
        borderTop: "1px solid var(--border-hairline)",
        background: "var(--surface-chrome)",
        backdropFilter: "blur(var(--blur-chrome))",
      }}
    >
      <p
        style={{
          display: "flex",
          gap: "var(--space-3)",
          margin: 0,
          flex: "1 1 48ch",
          minWidth: 0,
          fontSize: "var(--fs-xs)",
          lineHeight: "var(--lh-relaxed)",
          color: "var(--text-muted)",
        }}
      >
        <span
          aria-hidden
          style={{
            color: "var(--brand-pink)",
            display: "inline-flex",
            flex: "0 0 auto",
            marginTop: 2,
          }}
        >
          <Icon name="shield" size={14} />
        </span>
        Tools and plugins you submit run in their own sandboxed processes and
        are deleted when the run ends. Nothing is stored. An API key in your
        flow does travel to the engine to reach the model — use a key you are
        willing to spend, and revoke it when you are done.
      </p>

      <dl
        style={{
          display: "flex",
          flexWrap: "wrap",
          margin: 0,
          gap: "var(--space-2) var(--space-6)",
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
    </footer>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
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
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        minWidth: 0,
      }}
    >
      <label className="hd-eyebrow" htmlFor="playground-example">
        Example
      </label>

      <Select
        id="playground-example"
        value={current.title}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          const next = EXAMPLES.find((e) => e.title === event.target.value);
          if (next) onSelect(next);
        }}
        options={EXAMPLES.map((example) => example.title)}
        disabled={disabled}
        style={{ width: 260, flex: "0 0 auto" }}
      />

      {current.needsKey && (
        <Badge tone="neutral" uppercase title="Needs your own model credential">
          key
        </Badge>
      )}

      <span
        className="hd-playground-blurb"
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: "var(--fs-xs)",
          color: "var(--text-muted)",
        }}
      >
        {current.blurb}
      </span>
    </div>
  );
}
