"use client";

import Editor from "./Editor";
import WindowTabs from "./WindowTabs";
import { WindowIconButton, WindowSelect } from "./WindowControls";
import CodeList from "./CodeList";
import RunLog from "./RunLog";
import Glyph from "../Glyph";
import { Icon } from "@/ds-heddle";
import {
  API_BASE,
  type Capabilities,
  type RequestPlugin,
  type RequestTool,
} from "@/lib/playground";
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

const FILE_STUB = "Whatever a tool in this run should be able to read.\n";

/* Cyan is the accent on a navy surface the way blurple is on paper, so a run
   in flight reads in the same colour the window's keys do. */
const statusTone: Record<Status, string> = {
  idle: "var(--slate-500)",
  running: "var(--cyan-400)",
  done: "var(--green-500)",
  error: "var(--red-500)",
};

/** The window strip a pane is titled by, above the code. */
const windowBar: React.CSSProperties = {
  display: "flex",
  flexShrink: 0,
  alignItems: "stretch",
  justifyContent: "space-between",
  borderBottom: "1px solid var(--border-inverse)",
};

/** The spec on the left, the run it produced on the right. */
export default function Build({ pg }: { pg: Playground }) {
  return (
    <>
      <section
        id="editors"
        tabIndex={-1}
        aria-label="Specification"
        className="hds-playground-pane"
      >
        <div style={windowBar}>
          <WindowTabs
            label="Editors"
            tabs={[
              { id: "spec", label: "Spec" },
              { id: "inputs", label: "Inputs" },
              { id: "tools", label: "Tools", badge: pg.tools.length },
              { id: "plugins", label: "Plugins", badge: pg.plugins.length },
              { id: "files", label: "Files", badge: pg.files.length },
            ]}
            active={pg.tab}
            onSelect={pg.setTab}
          />
          <WindowIconButton
            size="md"
            bordered={false}
            label="Restore example"
            onClick={pg.restore}
            title={`Restore the "${pg.example.title}" example`}
            style={{
              minHeight: 40,
              width: 40,
              borderLeft: "1px solid var(--border-inverse)",
            }}
          >
            <Glyph name="rotateCcw" size={14} />
          </WindowIconButton>
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
              placeholder="A Weave document, as YAML or JSON"
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
              note="A plugin adds component types the engine does not ship. The manifest declares them as data; the source runs in its own process, so it never sees the engine's memory or environment. Call serve({ ComponentType: { execute } }); it is supplied for you."
            />
          )}

          {/* Named by path rather than by name, which is the whole of the
              difference from the two tabs above: a tool is called, a file is
              found. The engine copies these into every node's workspace before
              the flow starts, so a tool reaches one at $HEDDLE_WORKSPACE. */}
          {pg.tab === "files" && (
            <CodeList
              kind="file"
              entries={pg.files.map((file) => ({
                name: file.path,
                source: file.content,
              }))}
              onChange={(next) =>
                pg.setFiles(
                  next.map((entry) => ({
                    path: entry.name,
                    content: entry.source,
                  })),
                )
              }
              limit={pg.limits?.maxRequestFiles ?? 20}
              emptySource={FILE_STUB}
              note="A file is put in every node's workspace before the run starts, at the path you give it, and is read-only there. It is content the run reads, such as a skill, a template or a fixture, rather than something the engine runs."
            />
          )}
        </div>
      </section>

      <section aria-label="Run" className="hds-playground-pane">
        <div
          style={{
            ...windowBar,
            flexWrap: "wrap",
            minHeight: 40,
            alignItems: "center",
            gap: "var(--space-3) var(--space-5)",
            padding: "var(--space-2) var(--space-5)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-5)",
              minWidth: 0,
            }}
          >
            <span className="hds-eyebrow hds-eyebrow-inverse">Run</span>
            <ProtocolPicker pg={pg} />
          </div>

          <span
            aria-live="polite"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-label)",
              textTransform: "uppercase",
              letterSpacing: "var(--ls-label)",
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
            protocol={pg.renderedIn}
          />
        </div>
      </section>
    </>
  );
}

/**
 * How the engine should render this run.
 *
 * Absent until a submitted plugin declares an encoder, which is the whole
 * mechanism stated in the interface: heddle renders one protocol of its own,
 * and every other one arrives in the request body beside the flow. Nothing is
 * installed on the engine to make this work.
 */
function ProtocolPicker({ pg }: { pg: Playground }) {
  if (pg.protocols.length < 2) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        minWidth: 0,
      }}
    >
      <label
        className="hds-eyebrow hds-eyebrow-inverse"
        htmlFor="playground-protocol"
      >
        Protocol
      </label>
      <WindowSelect
        id="playground-protocol"
        value={pg.protocol}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
          pg.setProtocol(event.target.value)
        }
        options={pg.protocols}
        disabled={pg.busy}
        style={{ width: 130, flex: "0 0 auto" }}
      />
    </div>
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
        background: "color-mix(in srgb, var(--surface-page) 85%, transparent)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}
    >
      <p
        style={{
          display: "flex",
          gap: "var(--space-3)",
          margin: 0,
          flex: "1 1 48ch",
          minWidth: 0,
          fontSize: "var(--fs-caption)",
          lineHeight: 1.6,
          color: "var(--text-muted)",
        }}
      >
        <span
          aria-hidden
          style={{
            color: "var(--text-accent)",
            display: "inline-flex",
            flex: "0 0 auto",
            marginTop: 2,
          }}
        >
          <Icon name="shield" size={14} />
        </span>
        Tools and plugins you submit run in their own sandboxed processes and
        are deleted when the run ends. Nothing is stored. An API key in your
        flow does travel to the engine to reach the model, so use a key you are
        willing to spend and revoke it when you are done.
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
            <dt className="hds-eyebrow">{term}</dt>
            <dd
              style={{
                margin: 0,
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-code-sm)",
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

/* A configuration problem rather than a failure, so it is the system's warning
   amber. The hue is mixed rather than taken from the --amber-100 pair, which
   is a light tint that does not flip with the theme. */
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        padding: "var(--space-4) var(--space-5)",
        borderBottom:
          "1px solid color-mix(in srgb, var(--amber-500) 35%, transparent)",
        background: "color-mix(in srgb, var(--amber-500) 9%, transparent)",
        fontSize: "var(--fs-body-sm)",
        lineHeight: 1.6,
        color: "var(--text-body)",
      }}
    >
      {children}
    </p>
  );
}
