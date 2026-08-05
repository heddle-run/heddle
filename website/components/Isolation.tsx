import { Badge, Card, SectionHeading } from "@/ds-heddle";
import { Reveal } from "@/components/motion/Reveal";
import { safeMode } from "@/lib/constants";

/* 005 — the sandboxing claims. Copy comes verbatim from safeMode in
   lib/constants.ts, which is checked against packages/core/src/sandbox/ and
   packages/server/DEPLOYMENT.md — mechanisms, not adjectives. The design's
   sample badges ("default in CI", "no daemon") were claims heddle does not
   make, so they are not here. */
export default function Isolation() {
  return (
    <section
      id="isolation"
      style={{
        borderTop: "1px solid var(--border-hairline)",
        background: "var(--surface-sunken)",
      }}
    >
      <div
        className="hds-container"
        style={{
          paddingTop: "var(--section-y)",
          paddingBottom: "var(--section-y)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <SectionHeading
            number="005"
            eyebrow="Isolation"
            title={
              <>
                Under <code style={{ fontSize: "0.85em" }}>{safeMode.flag}</code>
                , tools run confined, or they do not run at all.
              </>
            }
            lede="What the flag means, mechanism by mechanism."
          />
        </div>
        <div className="hds-isolation-grid">
          {safeMode.points.map((point, i) => (
            <Reveal key={point.title} index={i}>
              <Card title={point.title}>{point.description}</Card>
            </Reveal>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          <Badge tone="inverse" mono>
            {safeMode.flag}
          </Badge>
        </div>
      </div>
    </section>
  );
}
