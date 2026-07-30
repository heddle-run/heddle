"use client";

import { useState } from "react";
import { Icon } from "@/ds";

export default function CopyCommand({
  label,
  command,
}: {
  label: string;
  command: string;
}) {
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={`Copy: ${command}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        width: "100%",
        padding: "var(--space-3) var(--space-4)",
        background: "var(--bg-inset)",
        border: `1px solid ${hover ? "var(--brand-pink-30)" : "var(--border-default)"}`,
        borderRadius: "var(--radius-lg)",
        cursor: "pointer",
        textAlign: "left",
        transition: "border-color var(--dur-base) var(--ease-standard)",
      }}
    >
      <span
        className="hd-eyebrow"
        style={{ flex: "0 0 auto", color: "var(--text-faint)" }}
      >
        {label}
      </span>
      <code
        style={{
          flex: 1,
          minWidth: 0,
          overflowX: "auto",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-xs)",
          color: "var(--text-strong)",
        }}
      >
        {command}
      </code>
      <span
        style={{
          flex: "0 0 auto",
          display: "inline-flex",
          color: copied ? "var(--brand-pink)" : "var(--text-faint)",
          transition: "color var(--dur-fast) var(--ease-standard)",
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={14} />
      </span>
      <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
