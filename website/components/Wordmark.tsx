import { Icon } from "@/ds";

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
