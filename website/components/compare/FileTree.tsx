"use client";

import Glyph from "../Glyph";
import { Icon } from "@/ds-heddle";
import type { CompareFile } from "@/lib/compare";

interface Entry {
  /** The full file name, which is what selection is keyed on. */
  name: string;
  /** The part shown in the list — the leaf, under its directory. */
  leaf: string;
}

interface Group {
  directory?: string;
  entries: Entry[];
}

/* Files at the root first, then one group per directory, in the order the
   directories first appear. heddle's tools live in tools/, and showing that
   nesting is the point — it is why that column has four files. */
function group(files: CompareFile[]): Group[] {
  const root: Entry[] = [];
  const directories = new Map<string, Entry[]>();

  for (const file of files) {
    const cut = file.name.lastIndexOf("/");
    if (cut === -1) {
      root.push({ name: file.name, leaf: file.name });
      continue;
    }

    const directory = file.name.slice(0, cut);
    const entry = { name: file.name, leaf: file.name.slice(cut + 1) };
    const existing = directories.get(directory);
    if (existing) existing.push(entry);
    else directories.set(directory, [entry]);
  }

  return [
    ...(root.length > 0 ? [{ entries: root }] : []),
    ...[...directories].map(([directory, entries]) => ({
      directory,
      entries,
    })),
  ];
}

/* Everything here is styled from globals.css rather than inline, because the
   whole thing changes shape at 900px: a sidebar beside the code on a wide
   screen, a strip of files above it once the panes stack and a 10rem gutter
   would be a third of the width. */
export default function FileTree({
  files,
  active,
  onSelect,
  label,
}: {
  files: CompareFile[];
  active: string;
  onSelect: (name: string) => void;
  label: string;
}) {
  return (
    <nav aria-label={label} className="hds-compare-tree">
      {group(files).map((entry) => (
        <div
          key={entry.directory ?? "/"}
          className="hds-compare-tree-group"
          data-dir={entry.directory}
        >
          {entry.directory && (
            <div className="hds-compare-tree-dir">
              <Icon name="chevronDown" size={11} />
              <span>{entry.directory}</span>
            </div>
          )}

          {entry.entries.map((file) => (
            <button
              key={file.name}
              type="button"
              className="hds-compare-tree-file"
              aria-current={file.name === active ? "true" : undefined}
              onClick={() => onSelect(file.name)}
              title={file.name}
            >
              <span aria-hidden className="hds-compare-tree-icon">
                <Glyph name="fileCode" size={12} />
              </span>
              <span className="hds-compare-tree-leaf">
                {entry.directory && (
                  <span className="hds-compare-tree-prefix">
                    {entry.directory}/
                  </span>
                )}
                {file.leaf}
              </span>
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
