"use client";

export interface Tab {
  id: string;
  label: string;
  badge?: string | number;
}

export default function Tabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: Tab[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Editors"
      style={{ display: "flex", flexWrap: "wrap" }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(tab.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              minHeight: 44,
              padding: "0 var(--space-5)",
              cursor: "pointer",
              background: selected ? "var(--bg-sunken)" : "transparent",
              color: selected ? "var(--text-strong)" : "var(--text-muted)",
              border: 0,
              borderBottom: `2px solid ${selected ? "var(--brand-pink)" : "transparent"}`,
              fontFamily: "var(--font-sans)",
              fontSize: "var(--fs-xs)",
              fontWeight: selected
                ? "var(--fw-semibold)"
                : "var(--fw-medium)",
              textTransform: "uppercase",
              letterSpacing: "var(--tracking-widest)",
              transition:
                "color var(--dur-base) var(--ease-standard), background-color var(--dur-base) var(--ease-standard), border-color var(--dur-base) var(--ease-standard)",
            }}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== 0 && (
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--fs-2xs)",
                  fontVariantNumeric: "tabular-nums",
                  color: selected ? "var(--brand-pink)" : "var(--text-faint)",
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
