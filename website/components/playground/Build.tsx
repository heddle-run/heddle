"use client";

import Editor from "./Editor";
import Tabs from "./Tabs";
import CodeList from "./CodeList";
import RunLog from "./RunLog";
import { Icon } from "@/ds";
import { API_BASE, type Capabilities, type RequestPlugin, type RequestTool } from "@/lib/playground";
import type { Playground, Status } from "@/lib/use-playground";

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

const statusTone: Record<Status, string> = {
  idle: "var(--text-faint)",
  running: "var(--brand-pink)",
  done: "var(--hue-emerald)",
  error: "var(--hue-red)",
};

/** The spec on the left, the run it produced on the right. */
export default function Build({ pg }: { pg: Playground }) {
  return (
    <>
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
              { id: "tools", label: "Tools", badge: pg.tools.length },
              { id: "plugins", label: "Plugins", badge: pg.plugins.length },
            ]}
            active={pg.tab}
            onSelect={pg.setTab}
          />
          <button
            type="button"
            onClick={pg.restore}
            title={`Restore the "${pg.example.title}" example`}
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
          {pg.tab === "spec" && (
            <Editor
              fill
              label="Spec"
              value={pg.flow}
              onChange={pg.setFlow}
              rows={30}
              placeholder="An Agent Spec document, rooted at a Flow, as YAML or JSON"
            />
          )}

          {pg.tab === "inputs" && (
            <Editor
              fill
              label="Inputs"
              value={pg.inputs}
              onChange={pg.setInputs}
              rows={12}
              placeholder='{ "query": "..." }'
            />
          )}

          {pg.tab === "tools" && (
            <CodeList
              kind="tool"
              entries={pg.tools}
              onChange={(next) => pg.setTools(next as RequestTool[])}
              limit={pg.limits?.maxRequestTools ?? 10}
              emptySource={TOOL_STUB}
              note="A tool reads its arguments as JSON on stdin and writes JSON on stdout. It runs as a subprocess, inside the engine's sandbox."
            />
          )}

          {pg.tab === "plugins" && (
            <CodeList
              kind="plugin"
              entries={pg.plugins}
              onChange={(next) => pg.setPlugins(next as RequestPlugin[])}
              limit={pg.limits?.maxRequestPlugins ?? 5}
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
              color: statusTone[pg.status],
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
              }[pg.status]
            }
          </span>
        </div>

        <div style={{ minHeight: 0, flex: 1 }}>
          <RunLog
            events={pg.events}
            status={pg.status}
            result={pg.result}
            error={pg.error}
          />
        </div>
      </section>
    </>
  );
}

/** Shown above the editor when there is nothing behind the Run button. */
export function EngineNotice({ reachable }: { reachable?: boolean }) {
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

/** The security paragraph, and what the engine says it will accept. */
export function BuildStatusBar({
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
