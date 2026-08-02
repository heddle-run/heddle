/**
 * A tag on a library card.
 *
 * Not ds-heddle's `Badge`: its neutral tone pairs a hardcoded `--cloud-200`
 * background with `--text-body`, and dark theme flips only the second of those,
 * so a neutral badge is light-on-light there. The vendored system is kept
 * mergeable rather than patched (see ds-heddle/DEVIATIONS.md), so this draws
 * the pill from tokens that do flip.
 */
export default function LibraryTag({ children }: { children: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 22,
        padding: "0 9px",
        borderRadius: "var(--radius-pill)",
        border: "1px solid var(--border-hairline)",
        background: "transparent",
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 11.5,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}
