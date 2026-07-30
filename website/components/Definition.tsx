import { BoxedFrame, Icon } from "@/ds";
import { definition } from "@/lib/constants";

export default function Definition() {
  return (
    <section className="hd-section">
      <div className="hd-container">
        <BoxedFrame pad="var(--space-12)" beam>
          <figure
            style={{
              margin: 0,
              maxWidth: 760,
              marginInline: "auto",
              textAlign: "center",
            }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-flex",
                color: "var(--brand-pink)",
                opacity: 0.35,
              }}
            >
              <Icon name="quote" size={40} />
            </span>

            <figcaption
              style={{
                marginTop: "var(--space-6)",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "baseline",
                justifyContent: "center",
                gap: "var(--space-3)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--fs-2xl)",
                  fontWeight: "var(--fw-semibold)",
                  letterSpacing: "var(--tracking-tight)",
                  color: "var(--text-strong)",
                }}
              >
                {definition.word}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-xs)",
                  color: "var(--text-faint)",
                }}
              >
                {definition.pronunciation}
              </span>
              <span
                style={{
                  fontSize: "var(--fs-sm)",
                  color: "var(--text-muted)",
                }}
              >
                {definition.partOfSpeech}
              </span>
            </figcaption>

            <blockquote
              style={{
                margin: "var(--space-6) 0 0",
                fontSize: "clamp(20px,2.6vw,30px)",
                fontWeight: "var(--fw-light)",
                letterSpacing: "var(--tracking-tight)",
                lineHeight: "var(--lh-snug)",
                color: "var(--text-strong)",
              }}
            >
              {definition.body}
            </blockquote>
          </figure>
        </BoxedFrame>
      </div>
    </section>
  );
}
