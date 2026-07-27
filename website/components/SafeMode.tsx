import { BoxedFrame, Card, Icon, Badge } from "@/ds";
import SectionLabel from "./SectionLabel";
import CodeBlock from "./CodeBlock";
import { safeMode } from "@/lib/constants";

/**
 * Safe mode.
 *
 * The one section on this page making a security claim, so it states mechanisms
 * rather than adjectives — every line is traceable to packages/core/src/sandbox.
 * Keep it that way: no "enterprise-grade", no "bank-level", nothing unfalsifiable.
 */
export default function SafeMode() {
  return (
    <section id="safe" className="hd-section" style={{ scrollMarginTop: 80 }}>
      <div className="hd-container">
        <SectionLabel index="004">Isolation</SectionLabel>

        <div className="hd-split" style={{ alignItems: "start" }}>
          <div>
            <h2
              style={{
                margin: 0,
                maxWidth: "18ch",
                fontSize: "clamp(30px,4vw,48px)",
                fontWeight: "var(--fw-semibold)",
                letterSpacing: "var(--tracking-tight)",
                lineHeight: "var(--lh-snug)",
                color: "var(--text-strong)",
              }}
            >
              Someone else&rsquo;s code, on your machine.
            </h2>

            <p
              style={{
                margin: "var(--space-6) 0 0",
                maxWidth: "50ch",
                fontSize: "var(--fs-lg)",
                lineHeight: "var(--lh-relaxed)",
                color: "var(--text-body)",
              }}
            >
              A flow runs tools you wrote, tools a teammate wrote, and plugins
              from wherever you got them. Add{" "}
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.9em",
                  color: "var(--brand-pink)",
                }}
              >
                {safeMode.flag}
              </code>{" "}
              and every one of them executes inside a kernel-level sandbox —
              not a promise about behaviour, a boundary the operating system
              enforces.
            </p>

            <div style={{ marginTop: "var(--space-8)" }}>
              <CodeBlock
                label="terminal"
                code={`heddle run flow.yaml \\
    --tools-dir ./tools \\
    --safe --allow-env OPENAI_API_KEY`}
              />
            </div>

            <p
              style={{
                margin: "var(--space-4) 0 0",
                maxWidth: "50ch",
                fontSize: "var(--fs-sm)",
                lineHeight: "var(--lh-relaxed)",
                color: "var(--text-muted)",
              }}
            >
              Everything not named by{" "}
              <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.9em" }}>
                --allow-env
              </code>{" "}
              is stripped from the tool&rsquo;s environment, including the rest
              of your shell.
            </p>
          </div>

          <div
            className="hd-grid hd-grid-2"
            style={{ gap: "var(--space-4)" }}
          >
            {safeMode.points.map((point) => (
              <Card
                key={point.title}
                radius="2xl"
                tone="card"
                sheen
                hoverBorder
                pad="var(--space-6)"
              >
                <span
                  style={{
                    display: "inline-flex",
                    marginBottom: "var(--space-4)",
                    padding: "var(--space-2)",
                    borderRadius: "var(--radius-lg)",
                    background: "var(--brand-pink-05)",
                    border: "1px solid var(--brand-pink-20)",
                    color: point.hue,
                  }}
                >
                  <Icon name={point.icon} size={20} />
                </span>
                <h3
                  style={{
                    margin: "0 0 var(--space-2)",
                    fontSize: "var(--fs-base)",
                    fontWeight: "var(--fw-semibold)",
                    color: "var(--text-strong)",
                  }}
                >
                  {point.title}
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: "var(--fs-sm)",
                    lineHeight: "var(--lh-normal)",
                    color: "var(--text-body)",
                  }}
                >
                  {point.description}
                </p>
              </Card>
            ))}
          </div>
        </div>

        {/* The honest footnote. A sandbox that cannot start is worth saying out
            loud, because the failure is loud by design. */}
        <BoxedFrame
          corners="diagonal"
          edges="none"
          pad="var(--space-6)"
          style={{ marginTop: "var(--space-10)" }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "var(--space-4)",
            }}
          >
            <Badge uppercase>Platform support</Badge>
            <p
              style={{
                margin: 0,
                flex: 1,
                minWidth: "24ch",
                fontSize: "var(--fs-sm)",
                lineHeight: "var(--lh-relaxed)",
                color: "var(--text-muted)",
              }}
            >
              Sandboxing is available on Linux and macOS. On any other platform{" "}
              <code
                style={{ fontFamily: "var(--font-mono)", fontSize: "0.9em" }}
              >
                {safeMode.flag}
              </code>{" "}
              refuses to start the run rather than continuing without a
              boundary.
            </p>
          </div>
        </BoxedFrame>
      </div>
    </section>
  );
}
