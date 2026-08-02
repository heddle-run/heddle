/**
 * The wordmark: the lowercase word, set in Plex Sans Medium.
 *
 * There is no logo and no glyph beside it — the word is the mark. The nav, the
 * playground bar and the docs shell all set it at 17px; `sm` exists for the
 * places fumadocs gives it less room than that.
 */
export default function Wordmark({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-sans)",
        fontWeight: "var(--fw-medium)",
        fontSize: size === "sm" ? 15 : 17,
        letterSpacing: "-0.02em",
        color: "var(--text-strong)",
      }}
    >
      heddle
    </span>
  );
}
