import { definition } from "@/lib/constants";

/* The dictionary epigraph, in the serif editorial voice. The entry is the one
   from lib/constants.ts, verbatim — the metaphor is the pitch. */
export default function Definition() {
  return (
    <section
      style={{
        maxWidth: "var(--maxw-narrow)",
        margin: "0 auto",
        padding: "var(--section-y-sm) 24px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 34,
          color: "var(--text-strong)",
        }}
      >
        {definition.word}{" "}
        <span style={{ color: "var(--text-subtle)", fontSize: 24 }}>
          {definition.pronunciation}
        </span>{" "}
        <em style={{ fontSize: 24 }}>{definition.partOfSpeech}</em>
      </div>
      <p
        style={{
          fontFamily: "var(--font-serif)",
          fontSize: 21,
          fontStyle: "italic",
          color: "var(--text-body)",
          lineHeight: 1.6,
          margin: "12px 0 0",
        }}
      >
        {definition.body}
      </p>
      <div
        style={{
          width: 120,
          height: 2,
          background: "var(--gradient-thread)",
          margin: "26px auto 0",
        }}
      />
    </section>
  );
}
