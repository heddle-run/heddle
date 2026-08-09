import Link from "next/link";
import { FeatureListItem, SectionHeading } from "@/ds-heddle";
import { Reveal } from "@/components/motion/Reveal";
import { useCases } from "@/lib/constants";

/* 001 — what you can build, placed second on the page on purpose: the
   highest-value thing this page can do for a reader who has never heard the
   word "agent" is show them a job they recognise. Every entry is a real
   library agent, and the link under each one opens the page where the flow
   file itself can be read — a reader who sees the file has learned more
   about the product than the rest of this page can teach. It stays a
   hairline list, not a card grid: the register is a manifest, not adverts. */
export default function UseCases() {
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
          number="001"
          eyebrow="What you can build"
          title="Jobs it already does."
          lede="The library's ready-made agents. Each one is a text file you can open, read and change, and each runs with one command."
        />
        <div className="hds-inventory-list" style={{ marginTop: 36 }}>
          {useCases.map((item, i) => (
            <Reveal key={item.slug} index={Math.floor(i / 2)}>
              <FeatureListItem
                index={String(i + 1).padStart(2, "0")}
                title={item.title}
              >
                {item.detail}{" "}
                <Link
                  href={`/library/${item.slug}`}
                  style={{
                    color: "var(--text-accent)",
                    textDecoration: "none",
                    whiteSpace: "nowrap",
                  }}
                >
                  Read the flow →
                </Link>
              </FeatureListItem>
            </Reveal>
          ))}
        </div>
        <p
          style={{
            fontSize: 16,
            color: "var(--text-muted)",
            lineHeight: 1.62,
            margin: "24px 0 0",
            maxWidth: "62ch",
          }}
        >
          Open either in the{" "}
          <Link
            href="/library"
            style={{ color: "var(--text-accent)", textDecoration: "none" }}
          >
            library
          </Link>{" "}
          and the whole flow is there to read. A job of your own starts by
          changing a line of one.
        </p>
      </div>
    </div>
  );
}
