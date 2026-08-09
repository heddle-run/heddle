"use client";

import { useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Button, Icon, InstallCommand } from "@/ds-heddle";
import { AnimatedTerminal } from "@/components/AnimatedTerminal";
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

/* The opening chapter: one full viewport of centered display type over the
   live loom, then the proof — the spec window with the terminal overlapping
   it — as a second beat further down the same chapter. The old side-by-side
   hero grid is gone; the world is the composition now, and the copy floats
   on it the way kage floats its chapter cards over the temple. Copy is
   unchanged and still comes from lib/constants.ts. */
export default function Hero() {
  const [tabId, setTabId] = useState(installTabs[0].id);
  const tab = installTabs.find((t) => t.id === tabId) ?? installTabs[0];
  const reduce = useReducedMotion();

  const enter = (delay: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 18 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, delay, ease: [0.2, 0, 0.2, 1] as const },
        };

  return (
    <div>
      {/* Beat one: the statement, a full viewport. */}
      <div
        style={{
          minHeight: "calc(100svh - 96px)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          position: "relative",
          padding: "60px 24px 72px",
        }}
      >
        {/* The copy's own scrim: full-width soft band, not an oval patch. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: "10% 0",
            pointerEvents: "none",
            background:
              "linear-gradient(180deg, transparent 0%, color-mix(in srgb, var(--surface-page) 78%, transparent) 22%, color-mix(in srgb, var(--surface-page) 78%, transparent) 78%, transparent 100%)",
          }}
        />

        <motion.div
          {...enter(0)}
          style={{
            position: "relative",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "var(--ls-label)",
            textTransform: "uppercase",
            color: "var(--text-accent)",
            marginBottom: 24,
          }}
        >
          Declarative YAML · MIT
        </motion.div>

        <motion.h1
          {...enter(0.08)}
          style={{
            position: "relative",
            fontSize: "clamp(34px, 6.4vw, 72px)",
            fontWeight: "var(--fw-light)",
            lineHeight: 1.05,
            letterSpacing: "var(--ls-display)",
            color: "var(--text-strong)",
            margin: 0,
            maxWidth: "16ch",
            overflowWrap: "break-word",
          }}
        >
          A batteries-included declarative agent runtime.
        </motion.h1>

        <motion.p
          {...enter(0.16)}
          style={{
            position: "relative",
            fontSize: "var(--fs-body-lg)",
            color: "var(--text-muted)",
            lineHeight: 1.6,
            maxWidth: "52ch",
            margin: "22px 0 0",
          }}
        >
          Declare the agent once, in YAML. The loop, the sandbox, the retries
          and the server live in the runtime, not in your codebase.
        </motion.p>

        <motion.div
          {...enter(0.24)}
          style={{
            position: "relative",
            display: "flex",
            gap: 12,
            marginTop: 30,
            alignItems: "center",
            justifyContent: "center",
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
        </motion.div>

        <motion.div
          {...enter(0.32)}
          style={{ position: "relative", marginTop: 30, width: "100%", maxWidth: 560 }}
        >
          <div
            role="tablist"
            aria-label="Install commands"
            style={{
              display: "flex",
              gap: 4,
              marginBottom: 10,
              justifyContent: "center",
            }}
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
                    background: active ? "var(--surface-raised)" : "transparent",
                    color: active ? "var(--text-strong)" : "var(--text-subtle)",
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
            style={{ fontSize: 12.5, color: "var(--text-subtle)", marginTop: 8 }}
          >
            {tab.note}
          </div>
        </motion.div>

        <div className="hds-scroll-cue" aria-hidden="true">
          <span>Scroll</span>
          <span className="hds-scroll-cue-line" />
        </div>
      </div>

      {/* Beat two: the proof. The same spec-beside-run pairing the brand
          brief requires the hero to carry, restaged as its own moment. */}
      <div
        className="hds-container"
        style={{ maxWidth: 780, paddingBottom: 48 }}
      >
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
                style={{ padding: "11px 20px", fontSize: 12.5, color: "var(--slate-400)" }}
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
                <motion.div
                  key={i}
                  style={{ whiteSpace: "pre" }}
                  initial={reduce ? false : { opacity: 0, x: -6 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, amount: 0.2 }}
                  transition={{
                    duration: 0.3,
                    delay: 0.1 + i * 0.035,
                    ease: [0.2, 0, 0.2, 1],
                  }}
                >
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
                </motion.div>
              ))}
            </div>
          </div>

          <div className="hds-hero-terminal">
            <AnimatedTerminal
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
    </div>
  );
}
