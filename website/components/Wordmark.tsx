/**
 * The wordmark: the lowercase word, set in the machine face.
 *
 * There is no logo and no glyph beside it — the word is the mark. Under the
 * three-role type system the mono carries it, opened up +0.02em so it reads
 * as a mark rather than a mistyped word, with `text-transform: lowercase`
 * guarding against any ancestor capitalising it at the start of a heading.
 * The nav, the playground bar and the docs shell all set it at 17px; `sm`
 * exists for the places fumadocs gives it less room than that.
 */
export default function Wordmark({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontWeight: "var(--fw-medium)",
        fontSize: size === "sm" ? 15 : 17,
        letterSpacing: "0.02em",
        textTransform: "lowercase",
        color: "var(--text-strong)",
      }}
    >
      heddle
    </span>
  );
}
