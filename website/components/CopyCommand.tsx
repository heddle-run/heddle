"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * An install line. On paper it is a bordered box; on an inverted surface it
 * borrows the surrounding colours, so the same component serves both.
 */
export default function CopyCommand({
  label,
  command,
  inverted = false,
}: {
  label: string;
  command: string;
  inverted?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the command is selectable either way */
    }
  };

  return (
    <div
      className={cn(
        "flex items-stretch border",
        inverted ? "border-paper/40" : "border-ink",
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center border-r px-2.5 font-mono text-[0.625rem] uppercase tracking-[0.15em]",
          inverted
            ? "border-paper/40 text-paper/50"
            : "border-hairline text-muted-ink",
        )}
      >
        {label}
      </span>

      <code
        className={cn(
          // min-w-0 lets the box shrink below the command's width and scroll.
          "min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-3 py-3 text-left font-mono text-[0.8125rem]",
          inverted ? "text-paper" : "text-ink",
        )}
      >
        <span className={inverted ? "text-paper/40" : "text-muted-ink"}>$ </span>
        {command}
      </code>

      <button
        type="button"
        onClick={copy}
        aria-label={`Copy: ${command}`}
        className={cn(
          "flex w-12 shrink-0 items-center justify-center border-l transition-colors duration-100 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2",
          inverted
            ? "border-paper/40 text-paper hover:bg-paper hover:text-ink focus-visible:outline-paper"
            : "border-ink text-ink hover:bg-ink hover:text-paper focus-visible:outline-ink",
        )}
      >
        {copied ? (
          <Check size={16} strokeWidth={1.5} />
        ) : (
          <Copy size={16} strokeWidth={1.5} />
        )}
        <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
