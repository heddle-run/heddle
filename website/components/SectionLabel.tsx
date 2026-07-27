/** The numbered eyebrow that opens each section, trailed by a hairline that
 *  runs to the edge of the container — the design system's quiet way of
 *  marking a block without a heavy rule. */
export default function SectionLabel({
  index,
  children,
}: {
  index: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-4)",
        marginBottom: "var(--space-6)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-2xs)",
          fontWeight: "var(--fw-semibold)",
          letterSpacing: "var(--tracking-widest)",
          color: "var(--brand-pink)",
        }}
      >
        {index}
      </span>
      <span className="hd-eyebrow">{children}</span>
      <span
        aria-hidden
        style={{
          flex: 1,
          height: 1,
          background:
            "linear-gradient(90deg,var(--border-default),transparent)",
        }}
      />
    </div>
  );
}
