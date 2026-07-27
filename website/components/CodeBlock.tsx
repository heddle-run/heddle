/** A spec or terminal fragment. Inset surface, 1px border, mono at 12px —
 *  the design system reserves monospace for exactly this and numeric readouts. */
export default function CodeBlock({
  code,
  label,
  tone = "inset",
  maxHeight,
}: {
  code: string;
  label?: string;
  tone?: "inset" | "sunken";
  maxHeight?: number;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-xl)",
        background:
          tone === "inset" ? "var(--bg-inset)" : "var(--surface-subtle)",
        overflow: "hidden",
      }}
    >
      {label && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-4)",
            borderBottom: "1px solid var(--border-hairline)",
            background: "var(--surface-panel)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--brand-pink)",
            }}
          />
          <span className="hd-eyebrow">{label}</span>
        </div>
      )}
      <pre
        style={{
          margin: 0,
          padding: "var(--space-4)",
          overflow: "auto",
          maxHeight,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-xs)",
          lineHeight: 1.65,
          color: "var(--text-body)",
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
