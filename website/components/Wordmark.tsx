import { Icon } from "@/ds";

/* heddle's lockup, in the design system's wordmark idiom: a Lucide glyph beside
 * the name in Inter Medium with tight tracking. Two deliberate departures from
 * the upstream Wordmark — the name stays lowercase (brand rule, not styling),
 * and `.run` trails it in mono as a quiet domain marker. */
export default function Wordmark({
  size = "md",
  showDomain = true,
}: {
  size?: "sm" | "md" | "lg";
  showDomain?: boolean;
}) {
  const fs =
    size === "sm"
      ? "var(--fs-sm)"
      : size === "lg"
        ? "var(--fs-xl)"
        : "var(--fs-lg)";
  const glyph = size === "sm" ? 16 : size === "lg" ? 24 : 20;

  return (
    <span
      className="ff-text-transition"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        color: "var(--text-strong)",
        fontWeight: "var(--fw-medium)",
        letterSpacing: "var(--tracking-tight)",
        fontSize: fs,
      }}
    >
      <Icon name="waypoints" size={glyph} />
      <span>heddle</span>
      {showDomain && (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-xs)",
            color: "var(--text-faint)",
            letterSpacing: 0,
          }}
        >
          .run
        </span>
      )}
    </span>
  );
}
