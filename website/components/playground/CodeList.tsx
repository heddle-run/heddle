"use client";

import Editor from "./Editor";
import Glyph from "../Glyph";
import { Icon } from "@/ds-heddle";
import { WindowIconButton, WindowInput, WindowSelect } from "./WindowControls";
import { INTERPRETERS } from "@/lib/playground";

interface Entry {
  name: string;
  source: string;
  interpreter?: string;
}

export default function CodeList({
  entries,
  onChange,
  kind,
  limit,
  note,
  emptySource,
  emptyManifest,
}: {
  entries: Entry[];
  onChange: (entries: Entry[]) => void;
  kind: "tool" | "plugin" | "file";
  limit: number;
  note: string;
  emptySource: string;
  emptyManifest?: unknown;
}) {
  const update = (index: number, patch: Partial<Entry>) => {
    onChange(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  };

  const add = () => {
    onChange([
      ...entries,
      {
        // A file is named by where it lands, so a new one needs a path rather
        // than an identifier — and one with an extension, since the tool that
        // reads it is usually globbing for it.
        name: kind === "file" ? `notes-${entries.length + 1}.md` : `${kind}_${entries.length + 1}`,
        source: emptySource,
        ...(kind === "tool"
          ? { interpreter: "sh" }
          : emptyManifest
            ? { manifest: emptyManifest }
            : {}),
      },
    ]);
  };

  const remove = (index: number) => {
    onChange(entries.filter((_, i) => i !== index));
  };

  return (
    <div>
      <p
        style={{
          margin: 0,
          padding: "var(--space-3) var(--space-5)",
          borderBottom: "1px solid var(--border-inverse)",
          fontSize: "var(--fs-caption)",
          lineHeight: 1.6,
          color: "var(--slate-400)",
        }}
      >
        {note}
      </p>

      {entries.length === 0 && (
        <p
          className="hds-eyebrow"
          style={{
            margin: 0,
            padding: "var(--space-10) var(--space-5)",
            textAlign: "center",
            color: "var(--slate-500)",
          }}
        >
          No {kind}s
        </p>
      )}

      {entries.map((entry, index) => (
        <div
          key={index}
          style={{ borderBottom: "1px solid var(--border-inverse)" }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-2) var(--space-3)",
              borderBottom: "1px solid var(--border-inverse)",
              background: "var(--surface-code-alt)",
            }}
          >
            <label className="sr-only" htmlFor={`${kind}-name-${index}`}>
              {kind} {kind === "file" ? "path" : "name"}
            </label>
            <WindowInput
              id={`${kind}-name-${index}`}
              value={entry.name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                update(index, { name: e.target.value })
              }
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={kind === "file" ? "path" : "name"}
              style={{ minWidth: 0, flex: 1 }}
            />

            {entry.interpreter !== undefined && (
              <>
                <label className="sr-only" htmlFor={`${kind}-interp-${index}`}>
                  interpreter
                </label>
                <WindowSelect
                  id={`${kind}-interp-${index}`}
                  value={entry.interpreter}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    update(index, { interpreter: e.target.value })
                  }
                  options={INTERPRETERS}
                  style={{ width: 120, flex: "0 0 auto" }}
                />
              </>
            )}

            <WindowIconButton
              label={`Remove ${kind} ${entry.name}`}
              onClick={() => remove(index)}
            >
              <Icon name="x" size={13} />
            </WindowIconButton>
          </div>

          <Editor
            label={`${kind} ${entry.name} ${kind === "file" ? "content" : "source"}`}
            value={entry.source}
            onChange={(source) => update(index, { source })}
            rows={12}
          />
        </div>
      ))}

      {entries.length < limit && (
        <button
          type="button"
          onClick={add}
          style={{
            display: "flex",
            minHeight: 44,
            width: "100%",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--space-2)",
            border: 0,
            borderTop: "1px solid var(--border-inverse)",
            background: "transparent",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--fs-label)",
            textTransform: "uppercase",
            letterSpacing: "var(--ls-label)",
            color: "var(--slate-400)",
            transition: "var(--transition-control)",
          }}
        >
          <Glyph name="plus" size={14} />
          Add {kind}
        </button>
      )}
    </div>
  );
}
