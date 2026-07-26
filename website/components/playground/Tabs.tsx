"use client";

import { cn } from "@/lib/cn";

export interface Tab {
  id: string;
  label: string;
  /** Shown after the label, e.g. a count of open editors. */
  badge?: string | number;
}

/**
 * Section switcher. Active is a full inversion rather than an underline or a
 * tint, which is the only emphasis this palette has.
 */
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
    <div role="tablist" aria-label="Editors" className="flex flex-wrap">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(tab.id)}
            className={cn(
              "flex min-h-[44px] items-center gap-2 border-r border-hairline px-5 font-mono text-[0.6875rem] uppercase tracking-[0.2em] transition-colors duration-100",
              "focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink",
              selected
                ? "bg-ink text-paper"
                : "bg-paper text-muted-ink hover:bg-ink hover:text-paper",
            )}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge !== 0 && (
              <span
                className={cn(
                  "font-mono text-[0.625rem] tabular-nums",
                  selected ? "text-paper/60" : "text-muted-ink",
                )}
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
