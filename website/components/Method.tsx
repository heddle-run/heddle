import { SectionHeading } from "@/ds-heddle";
import { Reveal } from "@/components/motion/Reveal";

/* 003 — the method grid. Four moves from the design template; the copy states
   commands and flags that exist (heddle run, --safe, heddle-server). */
const MOVES = [
  {
    title: "Declare",
    detail: "One document describes the model, the tools and the limits.",
  },
  {
    title: "Point",
    detail: "heddle run flow.yaml. No project scaffold, no dependency tree.",
  },
  {
    title: "Confine",
    detail:
      "--safe drops every tool into an OS sandbox before it can touch anything.",
  },
  {
    title: "Serve",
    detail:
      "heddle-server exposes the identical spec over HTTP with streaming.",
  },
];

export default function Method() {
  return (
    <section id="method">
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
          eyebrow="Method"
          title="Three moves, then it runs."
          lede="The fourth is optional, and it is the one everyone reaches for by Friday."
        />
        <div className="hds-method-grid">
          {MOVES.map((move, i) => (
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
    </section>
  );
}
