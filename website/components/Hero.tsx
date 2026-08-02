"use client";

import { useState, type ReactNode } from "react";
import { Button, Icon, InstallCommand, Terminal } from "@/ds-heddle";
import { GITHUB_URL, installTabs, specimenSpread, steps } from "@/lib/constants";

/* The spec in the window is the real Open Agent Specification fragment from
   the Declare step — the design template drew a simplified YAML here, and the
   brand rule is that spec snippets are checkable, not illustrative. */
const SPEC_LINES = steps[0].code.split("\n").slice(1, 15);

/* The run beside it is the specimen run log, trimmed to the window. */
const TERMINAL_LINES = specimenSpread.terminal.slice(0, 9).map((line) => ({
  text: line.text,
  kind:
    line.kind === "prompt"
      ? ("prompt" as const)
      : line.kind === "muted"
        ? ("dim" as const)
        : line.kind === "tool"
          ? ("tool" as const)
          : undefined,
}));

/* Minimal YAML colouring in the template's key/value scheme. */
function yamlLine(line: string): ReactNode {
  if (/^\s*#/.test(line)) {
    return <span style={{ color: "var(--code-comment)" }}>{line}</span>;
  }
  const kv = line.match(/^(\s*(?:-\s)?)([$\w]+)(:)(.*)$/);
  if (kv) {
    return (
      <>
        <span style={{ color: "var(--code-punct)" }}>{kv[1]}</span>
        <span style={{ color: "var(--code-key)" }}>{kv[2]}</span>
        <span style={{ color: "var(--code-punct)" }}>{kv[3]}</span>
        <span style={{ color: "var(--code-string)" }}>{kv[4]}</span>
      </>
    );
  }
  const item = line.match(/^(\s*-\s)(.*)$/);
  if (item) {
    return (
      <>
        <span style={{ color: "var(--code-punct)" }}>{item[1]}</span>
        <span style={{ color: "var(--code-string)" }}>{item[2]}</span>
      </>
    );
  }
  return <span style={{ color: "var(--code-fg)" }}>{line}</span>;
}

export default function Hero() {
  const [tabId, setTabId] = useState(installTabs[0].id);
  const tab = installTabs.find((t) => t.id === tabId) ?? installTabs[0];

  return (
    <section
      style={{
        background: "var(--gradient-warp)",
        borderBottom: "1px solid var(--border-hairline)",
      }}
    >
      <div
        className="hds-container hds-hero-grid"
        style={{ paddingTop: 88, paddingBottom: 72 }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "var(--ls-label)",
              textTransform: "uppercase",
              color: "var(--text-accent)",
              marginBottom: 20,
            }}
          >
            Declarative YAML · MIT
          </div>

          <h1
            style={{
              fontSize: "clamp(34px, 5.2vw, 54px)",
              fontWeight: "var(--fw-light)",
              lineHeight: 1.06,
              letterSpacing: "var(--ls-display)",
              color: "var(--text-strong)",
              margin: 0,
              overflowWrap: "break-word",
            }}
          >
            A batteries-included declarative agent runtime.
          </h1>

          <p
            style={{
              fontSize: "var(--fs-body-lg)",
              color: "var(--text-muted)",
              lineHeight: 1.6,
              maxWidth: "46ch",
              margin: "20px 0 0",
            }}
          >
            Declare the agent once, in YAML. The loop, the sandbox, the retries
            and the server live in the runtime — not in your codebase.
          </p>

          <div
            style={{
              display: "flex",
              gap: 12,
              marginTop: 28,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <Button
              as="a"
              href="/docs"
              size="lg"
              iconRight={<Icon name="arrowRight" size={16} />}
            >
              Read the docs
            </Button>
            <Button
              as="a"
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              size="lg"
              variant="secondary"
              iconLeft={<Icon name="github" size={16} />}
            >
              Star on GitHub
            </Button>
          </div>

          <div style={{ marginTop: 26, maxWidth: 560 }}>
            <div
              role="tablist"
              aria-label="Install commands"
              style={{ display: "flex", gap: 4, marginBottom: 10 }}
            >
              {installTabs.map((t) => {
                const active = t.id === tabId;
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTabId(t.id)}
                    style={{
                      height: 30,
                      padding: "0 12px",
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      letterSpacing: "0.04em",
                      borderRadius: "var(--radius-control)",
                      border: `1px solid ${active ? "var(--border-default)" : "transparent"}`,
                      background: active
                        ? "var(--surface-raised)"
                        : "transparent",
                      color: active
                        ? "var(--text-strong)"
                        : "var(--text-subtle)",
                      transition: "var(--transition-control)",
                    }}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            <div className="hds-install" style={{ display: "grid", gap: 8 }}>
              {tab.commands.map((command) => (
                <InstallCommand key={command.cmd} command={command.cmd} />
              ))}
            </div>

            <div
              style={{
                fontSize: 12.5,
                color: "var(--text-subtle)",
                marginTop: 8,
              }}
            >
              {tab.note}
            </div>
          </div>
        </div>

        <div className="hds-hero-windows" style={{ position: "relative" }}>
          <div
            style={{
              background: "var(--surface-code)",
              border: "1px solid var(--border-inverse)",
              borderRadius: "var(--radius-card)",
              overflow: "hidden",
              fontFamily: "var(--font-mono)",
              boxShadow: "0 24px 60px -24px rgba(0,0,0,.7)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "stretch",
                borderBottom: "1px solid var(--border-inverse)",
              }}
            >
              <span
                style={{
                  padding: "11px 20px",
                  fontSize: 12.5,
                  color: "var(--code-fg)",
                  background: "var(--surface-code-alt)",
                  borderRight: "1px solid var(--border-inverse)",
                }}
              >
                flow.yaml
              </span>
              <span
                style={{
                  padding: "11px 20px",
                  fontSize: 12.5,
                  color: "var(--slate-400)",
                  borderRight: "1px solid var(--border-inverse)",
                }}
              >
                tools/
              </span>
              <span
                style={{
                  padding: "11px 20px",
                  fontSize: 12.5,
                  color: "var(--slate-400)",
                }}
              >
                README
              </span>
            </div>
            <div
              style={{
                padding: "16px 18px",
                fontSize: 13.5,
                lineHeight: 1.7,
                overflowX: "auto",
              }}
            >
              {SPEC_LINES.map((line, i) => (
                <div key={i} style={{ whiteSpace: "pre" }}>
                  <span
                    style={{
                      color: "var(--code-punct)",
                      opacity: 0.55,
                      display: "inline-block",
                      width: "2.6ch",
                    }}
                  >
                    {i + 1}
                  </span>
                  {yamlLine(line)}
                </div>
              ))}
            </div>
          </div>

          <div className="hds-hero-terminal">
            <Terminal
              title="zsh — heddle"
              lines={TERMINAL_LINES}
              style={{
                background: "var(--surface-code-alt)",
                boxShadow: "0 32px 70px -20px rgba(0,0,0,.85)",
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
