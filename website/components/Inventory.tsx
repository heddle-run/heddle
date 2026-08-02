import { FeatureListItem, SectionHeading, Stat } from "@/ds-heddle";
import { manifest, notInProject } from "@/lib/constants";

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
        <div className="hds-inventory-grid" style={{ marginTop: 36 }}>
          <div className="hds-inventory-list">
            {manifest.map((item, i) => (
              <FeatureListItem
                key={item.title}
                index={String(i + 1).padStart(2, "0")}
                title={item.title}
              >
                {item.detail}
              </FeatureListItem>
            ))}
          </div>
          <div className="hds-stats">
            {notInProject.map((stat) => (
              <Stat key={stat.label} value={stat.value} label={stat.label} />
            ))}
            <p
              style={{
                fontSize: 13,
                color: "var(--text-subtle)",
                lineHeight: 1.6,
                margin: 0,
                maxWidth: "26ch",
              }}
            >
              What the batteries cost your project: everything a library would
              have added, at zero.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
