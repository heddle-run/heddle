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

/* The opening chapter, back in the original two-column composition: copy on
   the left, the spec window with the terminal overlapping it on the right,
   one viewport, over the live loom. The windows sit where the braid sweeps,
   which is the point — navy panes over the threads, the same layering the
   old painted hero had. Copy is unchanged and still comes from
   lib/constants.ts. `batteries-included` is one 18-character word, so the
   H1 keeps its 34px floor with break-word — check a 375px viewport before
   changing either. */
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
    <div
      style={{
        /* One viewport minus the fixed bar's 60px (main's paddingTop);
           the Chapter wrapper adds nothing for the hero, so this is the
           whole stage and the content centres in it without a dead band
           on top. */
        minHeight: "calc(100svh - 60px)",
        display: "flex",
        alignItems: "center",
        position: "relative",
        paddingBottom: 56,
      }}
    >
      {/* No scrim: the braid lives on the right where the opaque windows
          sit, so the copy column reads on plain ivory — an earlier radial
          wash here clipped at its element's edge and left a visible seam
          over the threads. */}
      <div
        className="hds-container hds-hero-grid"
        style={{ position: "relative", zIndex: 1, width: "100%" }}
      >
        <div>
          <motion.div
            {...enter(0)}
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
          </motion.div>

          <motion.h1
            {...enter(0.08)}
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
          </motion.h1>

          <motion.p
            {...enter(0.16)}
            style={{
              fontSize: "var(--fs-body-lg)",
              color: "var(--text-muted)",
              lineHeight: 1.6,
              maxWidth: "46ch",
              margin: "20px 0 0",
            }}
          >
            Declare the agent once, in YAML. The loop, the sandbox, the retries
            and the server live in the runtime, not in your codebase.
          </motion.p>

          <motion.div
            {...enter(0.24)}
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
          </motion.div>

          <motion.div {...enter(0.32)} style={{ marginTop: 26, maxWidth: 560 }}>
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
          </motion.div>
        </div>

        <motion.div
          {...enter(0.2)}
          className="hds-hero-windows"
          style={{ position: "relative" }}
        >
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
                <motion.div
                  key={i}
                  style={{ whiteSpace: "pre" }}
                  initial={reduce ? false : { opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    duration: 0.3,
                    delay: 0.3 + i * 0.035,
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
        </motion.div>
      </div>

      <div className="hds-scroll-cue" aria-hidden="true">
        <span>Scroll</span>
        <span className="hds-scroll-cue-line" />
      </div>
    </div>
  );
}
