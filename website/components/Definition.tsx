import { definition } from "@/lib/constants";

/* The dictionary epigraph, in the serif editorial voice. The entry is the one
   from lib/constants.ts, verbatim — the metaphor is the pitch. The little
   hand-drawn SVG weave that used to sit beneath it (five warp ticks, a weft
   that drew itself on scroll) is retired: this chapter is now the loom
   world's own close-up — the camera pulls in and the real weft crosses the
   real warp behind this copy (weave-world/chapters.ts, keyframe 6), so the
   2D miniature had become a duplicate. That also removes this component's
   gsap/ScrollTrigger dependency; it is a server component again. */
export default function Definition() {
  return (
    <div
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
        {/* The one line on the site with phonetic glyphs. Newsreader does
            not promise IPA coverage, so this span alone is set in Gentium
            Plus — a fallback mid-word would break the page's best moment. */}
        <span
          style={{
            fontFamily: "var(--font-gentium), var(--font-serif)",
            color: "var(--text-subtle)",
            fontSize: 24,
          }}
        >
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
    </div>
  );
}
