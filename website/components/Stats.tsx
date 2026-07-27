import { BoxedFrame } from "@/ds";
import { stats } from "@/lib/constants";

/** Four countable claims. The design system states numbers plainly — semibold
 *  numerals at display size, tight tracking, the label in micro-caps beneath. */
export default function Stats() {
  return (
    <section style={{ paddingBottom: "var(--space-16)" }}>
      <div className="hd-container">
        <BoxedFrame pad="var(--space-8)">
          <dl
            className="hd-grid hd-grid-4"
            style={{ margin: 0, textAlign: "center" }}
          >
            {stats.map((stat) => (
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
