import { BoxedFrame, Icon } from "@/ds";
import SectionLabel from "./SectionLabel";
import { manifest, notInProject } from "@/lib/constants";

/* The section that has to earn the word "included". A checklist rather than a
   card grid, because the claim is breadth and a reader should be able to count
   it. The zeros beneath are the other half: what all of it costs the project. */
export default function Manifest() {
  return (
    <section
      id="included"
      className="hd-section"
      style={{ scrollMarginTop: 80 }}
    >
      <div className="hd-container">
        <SectionLabel index="001">Inventory</SectionLabel>

        <div className="hd-split" style={{ alignItems: "start" }}>
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
            What comes in the box.
          </h2>

          <p
            style={{
              margin: 0,
              fontSize: "var(--fs-lg)",
              lineHeight: "var(--lh-relaxed)",
              color: "var(--text-body)",
            }}
          >
            Every line below is something you would otherwise choose, wire up
            and maintain yourself before an agent was fit to run in front of
            anyone. They are listed rather than summarised because
            &ldquo;included&rdquo; should be countable — each one is a feature
            in the README, not an adjective.
          </p>
        </div>

        <BoxedFrame
          pad="var(--space-8)"
          style={{ marginTop: "var(--space-12)" }}
        >
          <ul
            className="hd-manifest"
            style={{ listStyle: "none", margin: 0, padding: 0 }}
          >
            {manifest.map((item) => (
              <li
                key={item.title}
                style={{
                  display: "flex",
                  gap: "var(--space-4)",
                  alignItems: "start",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    display: "inline-flex",
                    flex: "0 0 auto",
                    marginTop: 2,
                    color: "var(--brand-pink)",
                  }}
                >
                  <Icon name={item.icon} size={16} />
                </span>

                <span>
                  <span
                    style={{
                      display: "block",
                      fontSize: "var(--fs-base)",
                      fontWeight: "var(--fw-medium)",
                      color: "var(--text-strong)",
                    }}
                  >
                    {item.title}
                  </span>
                  {/* Prose, so it is set in Inter rather than the monospace
                      stack — that is reserved for code, commands and micro
                      labels. */}
                  <span
                    style={{
                      display: "block",
                      marginTop: "var(--space-1)",
                      fontSize: "var(--fs-sm)",
                      lineHeight: "var(--lh-relaxed)",
                      color: "var(--text-body)",
                    }}
                  >
                    {item.detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </BoxedFrame>

        <BoxedFrame
          corners="diagonal"
          edges="none"
          pad="var(--space-8)"
          style={{ marginTop: "var(--space-6)" }}
        >
          <p
            className="hd-eyebrow"
            style={{
              margin: "0 0 var(--space-8)",
              display: "block",
              textAlign: "center",
            }}
          >
            And what it adds to your project
          </p>

          <dl
            className="hd-grid hd-grid-4"
            style={{ margin: 0, textAlign: "center" }}
          >
            {notInProject.map((stat) => (
              <div key={stat.label}>
                <dd
                  style={{
                    margin: 0,
                    fontSize: "var(--fs-5xl)",
                    fontWeight: "var(--fw-semibold)",
                    letterSpacing: "var(--tracking-tighter)",
                    lineHeight: 1,
                    color: "var(--text-strong)",
                  }}
                >
                  {stat.value}
                </dd>
                <dt
                  className="hd-eyebrow"
                  style={{ marginTop: "var(--space-3)", display: "block" }}
                >
                  {stat.label}
                </dt>
              </div>
            ))}
          </dl>
        </BoxedFrame>
      </div>
    </section>
  );
}
