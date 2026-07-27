import { StepCard } from "@/ds";
import SectionLabel from "./SectionLabel";
import CodeBlock from "./CodeBlock";
import { steps } from "@/lib/constants";

const glyphs = ["file-code", "plug", "play"];
const hues = [
  "var(--brand-pink)",
  "var(--hue-purple)",
  "var(--hue-emerald)",
];

export default function Steps() {
  return (
    <section id="method" className="hd-section" style={{ scrollMarginTop: 80 }}>
      <div className="hd-container">
        <SectionLabel index="002">Method</SectionLabel>

        <div style={{ textAlign: "center", marginBottom: "var(--space-16)" }}>
          <h2
            style={{
              margin: 0,
              fontSize: "clamp(30px,4vw,48px)",
              fontWeight: "var(--fw-semibold)",
              letterSpacing: "var(--tracking-tight)",
              lineHeight: "var(--lh-snug)",
              color: "var(--text-strong)",
            }}
          >
            Three moves, then it runs.
          </h2>
          <p
            style={{
              margin: "var(--space-4) auto 0",
              maxWidth: "var(--container-prose)",
              fontSize: "var(--fs-base)",
              lineHeight: "var(--lh-relaxed)",
              color: "var(--text-body)",
            }}
          >
            Declare the shape of the work. Hand it the tools. Pull the lever.
          </p>
        </div>

        <div className="hd-grid hd-grid-3" style={{ gap: "var(--space-8)" }}>
          {steps.map((step, i) => (
            <div
              key={step.number}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-6)",
              }}
            >
              <StepCard
                icon={glyphs[i]}
                hue={hues[i]}
                title={`${step.number} — ${step.title}`}
                body={step.description}
              />
              <CodeBlock code={step.code} maxHeight={280} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
