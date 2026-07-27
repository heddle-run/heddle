"use client";

import Editor from "./Editor";
import { Icon, Select } from "@/ds";
import { INTERPRETERS } from "@/lib/playground";

interface Entry {
  name: string;
  source: string;
  interpreter?: string;
}

/**
 * The editable list behind the Tools and Plugins tabs.
 *
 * Both are a name plus a body; tools additionally choose an interpreter, which
 * the engine turns into a shebang. Names are constrained here to the same
 * pattern the engine enforces, so a name that cannot work is refused while it
 * is being typed rather than on submit.
 */
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
  kind: "tool" | "plugin";
  limit: number;
  note: string;
  emptySource: string;
  /**
   * Starting manifest for a new plugin. Required for plugins: the engine
   * refuses one without a manifest, since a plugin's component types have to be
   * known while a flow is parsed rather than by running its code.
   */
  emptyManifest?: unknown;
}) {
  const update = (index: number, patch: Partial<Entry>) => {
    onChange(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  };

  const add = () => {
    onChange([
      ...entries,
      {
        name: `${kind}_${entries.length + 1}`,
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
          borderBottom: "1px solid var(--border-hairline)",
          fontSize: "var(--fs-xs)",
          lineHeight: "var(--lh-relaxed)",
          color: "var(--text-muted)",
        }}
      >
        {note}
      </p>

      {entries.length === 0 && (
        <p
          className="hd-eyebrow"
          style={{
            margin: 0,
            padding: "var(--space-10) var(--space-5)",
            textAlign: "center",
          }}
        >
          No {kind}s
        </p>
      )}

      {entries.map((entry, index) => (
        <div
          key={index}
          style={{ borderBottom: "1px solid var(--border-hairline)" }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-2) var(--space-3)",
              borderBottom: "1px solid var(--border-hairline)",
              background: "var(--surface-subtle)",
            }}
          >
            <label className="sr-only" htmlFor={`${kind}-name-${index}`}>
              {kind} name
            </label>
            <input
              id={`${kind}-name-${index}`}
              value={entry.name}
              onChange={(e) => update(index, { name: e.target.value })}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder="name"
              style={{
                minHeight: 36,
                minWidth: 0,
                flex: 1,
                padding: "0 var(--space-3)",
                background: "var(--bg-inset)",
                color: "var(--text-strong)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-lg)",
                outline: "none",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-xs)",
              }}
            />

            {entry.interpreter !== undefined && (
              <>
                <label className="sr-only" htmlFor={`${kind}-interp-${index}`}>
                  interpreter
                </label>
                <Select
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

            <button
              type="button"
              onClick={() => remove(index)}
              aria-label={`Remove ${kind} ${entry.name}`}
              style={{
                display: "flex",
                minHeight: 36,
                width: 36,
                flex: "0 0 auto",
                alignItems: "center",
                justifyContent: "center",
                background: "transparent",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-lg)",
                color: "var(--text-faint)",
                cursor: "pointer",
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <Editor
            label={`${kind} ${entry.name} source`}
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
            borderTop: "1px solid var(--border-hairline)",
            background: "transparent",
            cursor: "pointer",
            fontFamily: "var(--font-sans)",
            fontSize: "var(--fs-xs)",
            fontWeight: "var(--fw-medium)",
            textTransform: "uppercase",
            letterSpacing: "var(--tracking-widest)",
            color: "var(--text-muted)",
          }}
        >
          <Icon name="plus" size={14} />
          Add {kind}
        </button>
      )}
    </div>
  );
}
