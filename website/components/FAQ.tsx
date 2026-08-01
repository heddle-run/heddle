import { Icon } from "@/ds";
import SectionLabel from "./SectionLabel";
import { faqItems } from "@/lib/constants";

export default function FAQ() {
  return (
    <section className="hd-section">
      <div className="hd-container">
        <SectionLabel index="007">Questions</SectionLabel>

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
            Asked and answered.
          </h2>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
            }}
          >
            {faqItems.map((item) => (
              <details
                key={item.question}
                className="hd-faq"
                style={{
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-xl)",
                  background: "var(--surface-subtle)",
                  padding: "var(--space-4) var(--space-5)",
                }}
              >
                <summary
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "var(--space-4)",
                    cursor: "pointer",
                    listStyle: "none",
                    fontSize: "var(--fs-base)",
                    fontWeight: "var(--fw-medium)",
                    color: "var(--text-strong)",
                  }}
                >
                  {item.question}
                  <span
                    aria-hidden
                    className="hd-faq-chevron"
                    style={{
                      display: "inline-flex",
                      flex: "0 0 auto",
                      color: "var(--text-faint)",
                    }}
                  >
                    <Icon name="chevron-down" size={16} />
                  </span>
                </summary>
                <p
                  style={{
                    margin: "var(--space-3) 0 0",
                    paddingRight: "var(--space-8)",
                    fontSize: "var(--fs-sm)",
                    lineHeight: "var(--lh-relaxed)",
                    color: "var(--text-body)",
                  }}
                >
                  {item.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
