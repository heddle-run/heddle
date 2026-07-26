"use client";

import { Plus, X } from "lucide-react";
import Editor from "./Editor";
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
      <p className="border-b border-hairline px-5 py-3 font-mono text-[0.6875rem] leading-relaxed text-muted-ink">
        {note}
      </p>

      {entries.length === 0 && (
        <p className="px-5 py-10 text-center font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-muted-ink">
          No {kind}s
        </p>
      )}

      {entries.map((entry, index) => (
        <div key={index} className="border-b border-hairline last:border-b-0">
          <div className="flex items-stretch border-b border-hairline">
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
              className="min-h-[44px] min-w-0 flex-1 bg-paper px-5 font-mono text-xs text-ink placeholder:text-muted-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
            />

            {entry.interpreter !== undefined && (
              <>
                <label className="sr-only" htmlFor={`${kind}-interp-${index}`}>
                  interpreter
                </label>
                <select
                  id={`${kind}-interp-${index}`}
                  value={entry.interpreter}
                  onChange={(e) => update(index, { interpreter: e.target.value })}
                  className="min-h-[44px] border-l border-hairline bg-paper px-4 font-mono text-[0.6875rem] uppercase tracking-[0.15em] text-muted-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
                >
                  {INTERPRETERS.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </>
            )}

            <button
              type="button"
              onClick={() => remove(index)}
              aria-label={`Remove ${kind} ${entry.name}`}
              className="flex min-h-[44px] w-11 items-center justify-center border-l border-hairline text-muted-ink transition-colors duration-100 hover:bg-ink hover:text-paper focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink"
            >
              <X size={14} strokeWidth={1.5} />
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
          className="flex min-h-[44px] w-full items-center justify-center gap-2 border-t border-hairline font-mono text-[0.6875rem] uppercase tracking-[0.2em] text-muted-ink transition-colors duration-100 hover:bg-ink hover:text-paper focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-ink"
        >
          <Plus size={14} strokeWidth={1.5} />
          Add {kind}
        </button>
      )}
    </div>
  );
}
