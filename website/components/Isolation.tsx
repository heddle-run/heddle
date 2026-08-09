import { Badge, Card, SectionHeading } from "@/ds-heddle";
import { Reveal } from "@/components/motion/Reveal";
import { safeMode } from "@/lib/constants";

/* 005 — the safety section, written to the question this page's reader is
   actually asking: "I am about to let an AI run things on my computer —
   what can it break?" Copy comes verbatim from safeMode in
   lib/constants.ts, which is checked against packages/core/src/sandbox/ and
   packages/server/DEPLOYMENT.md — mechanisms, not adjectives, in plain
   words. The design's sample badges ("default in CI", "no daemon") were
   claims heddle does not make, so they are not here. */
export default function Isolation() {
  return (
    <div>
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
            eyebrow="Safety"
            title="What it can and cannot touch."
            lede={
              <>
                You are letting an AI run things on your computer. Add{" "}
                <code style={{ fontSize: "0.9em" }}>{safeMode.flag}</code> and
                every tool runs inside a box the operating system enforces —
                here is what that means, mechanism by mechanism.
              </>
            }
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
    </div>
  );
}
