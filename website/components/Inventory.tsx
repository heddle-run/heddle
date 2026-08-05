import { FeatureListItem, SectionHeading } from "@/ds-heddle";
import { Reveal } from "@/components/motion/Reveal";
import { manifest } from "@/lib/constants";

/* 001 — the inventory that makes "batteries included" countable. Every line
   comes from lib/constants.ts, which is checked against the README; the
   design's five-item sample was replaced with the full manifest because the
   claim is breadth and a reader should be able to count it. It stays a list,
   not a card grid, for the same reason. */
export default function Inventory() {
  return (
    <section id="included">
      <div
        className="hds-container"
        style={{
          paddingTop: "var(--section-y)",
          paddingBottom: "var(--section-y)",
        }}
      >
        <SectionHeading
          number="001"
          eyebrow="Inventory"
          title="What comes in the box."
          lede="Each one is a feature in the README, not an adjective."
        />
        <div className="hds-inventory-list" style={{ marginTop: 36 }}>
          {manifest.map((item, i) => (
            <Reveal key={item.title} index={Math.floor(i / 2)}>
              <FeatureListItem
                index={String(i + 1).padStart(2, "0")}
                title={item.title}
              >
                {item.detail}
              </FeatureListItem>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
