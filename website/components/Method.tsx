import { SectionHeading } from "@/ds-heddle";
import { Reveal } from "@/components/motion/Reveal";
import { firstRun } from "@/lib/constants";

/* 003 — the path from interested to running, stated literally: what you
   need installed, what it costs to find out, how long it takes. The steps
   live in lib/constants.ts and are checked against
   docs/getting-started.mdx — a prerequisite the landing page omits is a
   reader who arrives at the docs feeling misled. */
export default function Method() {
  return (
    <div>
      <div
        className="hds-container"
        style={{
          paddingTop: "var(--section-y)",
          paddingBottom: "var(--section-y)",
        }}
      >
        <SectionHeading
          align="center"
          number="003"
          eyebrow="First run"
          title="About ten minutes to your first result."
          lede="What you need, in order. Most of it you may already have."
        />
        <div className="hds-method-grid">
          {firstRun.map((move, i) => (
            <Reveal key={move.title} index={i}>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  color: "var(--text-accent)",
                }}
              >
                {String(i + 1).padStart(2, "0")}
              </div>
              <div
                style={{
                  fontSize: "var(--fs-h4)",
                  fontWeight: "var(--fw-medium)",
                  color: "var(--text-strong)",
                  marginTop: 10,
                  letterSpacing: "var(--ls-heading)",
                }}
              >
                {move.title}
              </div>
              <p
                style={{
                  fontSize: 14,
                  color: "var(--text-muted)",
                  lineHeight: 1.6,
                  margin: "6px 0 0",
                }}
              >
                {move.detail}
              </p>
            </Reveal>
          ))}
        </div>
      </div>
    </div>
  );
}
