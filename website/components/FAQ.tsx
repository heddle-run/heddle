import { Icon, SectionHeading } from "@/ds-heddle";
import { faqItems } from "@/lib/constants";

/* 006 — native <details>, keyboard-accessible without JavaScript. */
export default function FAQ() {
  return (
    <div>
      <div
        className="hds-container"
        style={{
          paddingTop: "var(--section-y)",
          paddingBottom: "var(--section-y)",
          maxWidth: "var(--maxw-narrow)",
        }}
      >
        <SectionHeading
          number="006"
          eyebrow="Questions"
          title="Asked and answered."
        />
        <div style={{ marginTop: 28 }} className="hds-faq">
          {faqItems.map((item) => (
            <details
              key={item.question}
              style={{ borderTop: "1px solid var(--border-hairline)" }}
            >
              <summary
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  padding: "16px 0",
                  cursor: "pointer",
                  fontSize: 15.5,
                  fontWeight: "var(--fw-medium)",
                  color: "var(--text-strong)",
                  letterSpacing: "var(--ls-heading)",
                }}
              >
                {item.question}
                <Icon
                  name="chevronDown"
                  size={16}
                  style={{ color: "var(--text-subtle)" }}
                />
              </summary>
              <p
                style={{
                  fontSize: 14.5,
                  color: "var(--text-muted)",
                  lineHeight: "var(--lh-body)",
                  margin: "0 0 18px",
                  maxWidth: "68ch",
                }}
              >
                {item.answer}
              </p>
            </details>
          ))}
        </div>
      </div>
    </div>
  );
}
