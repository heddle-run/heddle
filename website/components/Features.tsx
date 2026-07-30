import { FeatureCard } from "@/ds";
import SectionLabel from "./SectionLabel";
import { features } from "@/lib/constants";

export default function Features() {
  const [lead, ...rest] = features;

  return (
    <section className="hd-section">
      <div className="hd-container">
        <SectionLabel index="003">Apparatus</SectionLabel>

        <h2
          style={{
            margin: "0 0 var(--space-12)",
            maxWidth: "20ch",
            fontSize: "clamp(30px,4vw,48px)",
            fontWeight: "var(--fw-semibold)",
            letterSpacing: "var(--tracking-tight)",
            lineHeight: "var(--lh-snug)",
            color: "var(--text-strong)",
          }}
        >
          What comes in the box.
        </h2>

        <div className="hd-bento">
          <FeatureCard
            className="hd-bento-hero"
            icon={lead.icon}
            hue={lead.hue}
            title={lead.title}
            body={lead.description}
            feature
            glow
          />
          {rest.map((f) => (
            <FeatureCard
              key={f.title}
              icon={f.icon}
              hue={f.hue}
              title={f.title}
              body={f.description}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
