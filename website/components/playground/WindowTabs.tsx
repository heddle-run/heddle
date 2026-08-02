"use client";

export interface Tab {
  id: string;
  label: string;
  badge?: string | number;
}

/**
 * The tab strip along the top of a navy code window.
 *
 * It is the hero's `flow.yaml · tools/ · README` strip made selectable — same
 * mono labels, same lifted `--surface-code-alt` for the one you are on, same
 * hairlines between. It belongs to the windows and reads illegibly anywhere
 * else, which is why it lives beside them rather than in `components/`.
 */
export default function WindowTabs({
  tabs,
  active,
  onSelect,
  label,
}: {
  tabs: Tab[];
  active: string;
  onSelect: (id: string) => void;
  /** What this group of tabs is, for a screen reader. */
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "stretch" }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="hds-window-tab"
            aria-selected={selected}
            onClick={() => onSelect(tab.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              minHeight: 40,
              padding: "0 var(--space-5)",
              cursor: "pointer",
              border: 0,
              borderRight: "1px solid var(--border-inverse)",
              background: selected ? "var(--surface-code-alt)" : "transparent",
              color: selected ? "var(--code-fg)" : "var(--slate-400)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-code-sm)",
              letterSpacing: "var(--ls-mono)",
              transition: "var(--transition-control)",
            }}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== 0 && (
              <span
                style={{
                  fontVariantNumeric: "tabular-nums",
                  color: selected ? "var(--cyan-300)" : "var(--code-punct)",
                }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
