"use client";

import { useState } from "react";
import CodePane from "./CodePane";
import FileTree from "./FileTree";
import { Button, Icon } from "@/ds";
import { GITHUB_URL } from "@/lib/constants";
import {
  countLines,
  heddle,
  isUnsupported,
  type Cell,
  type Framework,
  type Implementation,
  type UseCase,
} from "@/lib/compare";

/**
 * The same use case in heddle and in one other framework, side by side.
 *
 * heddle is pinned to the left pane; the picker in the playground's bar
 * chooses what fills the right one. The bar and the ledger below belong to
 * the page — this is the pair of panes between them.
 */
export function ComparePanes({
  useCase,
  rival,
  onOpen,
}: {
  useCase: UseCase;
  rival: Framework;
  onOpen: () => void;
}) {
  return (
    <>
      <Pane
        framework={heddle}
        cell={heddle.impls[useCase.id]}
        accent
        onOpen={onOpen}
      />
      <Pane framework={rival} cell={rival.impls[useCase.id]} />
    </>
  );
}

/* A cell is either an implementation or a written reason there is none, and
   the two look nothing alike — so this only picks between them. Each branch
   is its own component because one of them has state and the other must not
   pretend to. */
function Pane({
  framework,
  cell,
  accent = false,
  onOpen,
}: {
  framework: Framework;
  cell: Cell;
  accent?: boolean;
  onOpen?: () => void;
}) {
  if (isUnsupported(cell)) {
    return (
      <GapPane
        framework={framework}
        reason={cell.unsupported}
        accent={accent}
      />
    );
  }
  return (
    <ImplementationPane
      framework={framework}
      implementation={cell}
      accent={accent}
      onOpen={onOpen}
    />
  );
}

/** The heading every pane shares: whose column this is, and its measure. */
function PaneHeading({
  framework,
  accent,
  measure,
}: {
  framework: Framework;
  accent: boolean;
  measure: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        minHeight: 44,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        padding: "0 var(--space-5)",
        borderBottom: "1px solid var(--border-hairline)",
      }}
    >
      <a
        href={framework.docs}
        {...(framework.docs.startsWith("http")
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}
        title={`${framework.name} documentation`}
        className="ff-text-transition"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontSize: "var(--fs-sm)",
          fontWeight: "var(--fw-semibold)",
          letterSpacing: "var(--tracking-tight)",
          color: "var(--text-strong)",
        }}
      >
        {accent && (
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--brand-pink)",
            }}
          />
        )}
        {framework.name}
        <span aria-hidden style={{ color: "var(--text-faint)" }}>
          <Icon name="arrow-up-right" size={12} />
        </span>
      </a>

      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-2xs)",
          fontVariantNumeric: "tabular-nums",
          textTransform: "uppercase",
          letterSpacing: "var(--tracking-widest)",
          color: "var(--text-faint)",
          whiteSpace: "nowrap",
        }}
      >
        {measure}
      </span>
    </div>
  );
}

/* A use case this framework has no honest equivalent for. There is no code to
   show and none is invented: the column says what the framework does offer
   and why it is a different thing, which is the only answer that keeps the
   claim under the ledger true. */
function GapPane({
  framework,
  reason,
  accent,
}: {
  framework: Framework;
  reason: string;
  accent: boolean;
}) {
  return (
    <section aria-label={framework.name} className="hd-playground-pane">
      <PaneHeading
        framework={framework}
        accent={accent}
        measure="no equivalent"
      />

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <p
          style={{
            margin: 0,
            padding: "var(--space-5)",
            maxWidth: "56ch",
            fontSize: "var(--fs-xs)",
            lineHeight: "var(--lh-relaxed)",
            color: "var(--text-muted)",
          }}
        >
          {reason}
        </p>
      </div>
    </section>
  );
}

function ImplementationPane({
  framework,
  implementation,
  accent = false,
  onOpen,
}: {
  framework: Framework;
  implementation: Implementation;
  accent?: boolean;
  onOpen?: () => void;
}) {
  const [name, setName] = useState(implementation.files[0].name);

  /* The selected file is keyed by name, and the names change with the use
     case and the framework, so fall back to the first file rather than
     rendering nothing when the selection no longer exists. */
  const file =
    implementation.files.find((candidate) => candidate.name === name) ??
    implementation.files[0];

  const lines = countLines(implementation);
  const files = implementation.files.length;
  const packages = framework.packages.length;

  return (
    <section aria-label={framework.name} className="hd-playground-pane">
      <PaneHeading
        framework={framework}
        accent={accent}
        measure={
          `${lines} ${lines === 1 ? "line" : "lines"} · ` +
          `${files} ${files === 1 ? "file" : "files"} · ` +
          `${packages} ${packages === 1 ? "package" : "packages"}`
        }
      />

      <div className="hd-compare-pane-body">
        <FileTree
          files={implementation.files}
          active={file.name}
          onSelect={setName}
          label={`${framework.name} files`}
        />

        <div style={{ minWidth: 0, minHeight: 0, flex: 1, overflow: "auto" }}>
          <CodePane file={file} />
        </div>
      </div>

      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: "var(--space-4)",
          padding: "var(--space-3) var(--space-5)",
          borderTop: "1px solid var(--border-hairline)",
          background: "var(--surface-panel)",
        }}
      >
        <div
          style={{
            display: "flex",
            gap: "var(--space-3)",
            minWidth: 0,
            overflowX: "auto",
          }}
        >
          <span
            aria-hidden
            style={{
              color: "var(--brand-pink)",
              flex: "0 0 auto",
              marginTop: 1,
            }}
          >
            <Icon name="terminal" size={13} />
          </span>
          <pre
            style={{
              margin: 0,
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-2xs)",
              lineHeight: "var(--lh-relaxed)",
              color: "var(--text-muted)",
              whiteSpace: "pre",
            }}
          >
            {implementation.run}
          </pre>
        </div>

        {/* Only heddle's column has one: this flow is also a playground
            example, so the reader can run it here instead of installing
            anything. No other framework's column can make that offer. */}
        {onOpen && (
          <Button
            size="sm"
            variant="subtle"
            shape="rounded"
            icon="braces"
            onClick={onOpen}
            title="Load this flow into the editor"
            style={{ flex: "0 0 auto", marginLeft: "auto" }}
          >
            Open in the editor
          </Button>
        )}
      </div>
    </section>
  );
}

/** Countable facts about the two columns, under the panes. */
export function CompareLedger({
  useCase,
  rival,
}: {
  useCase: UseCase;
  rival: Framework;
}) {
  /* The last row is the only one that is about this use case rather than the
     framework, so it is also the only one with a gap to report. */
  const theirs = rival.impls[useCase.id];

  const rows: { term: string; mine: string; theirs: string; prose?: true }[] = [
    {
      term: "install",
      mine: heddle.install,
      theirs: rival.install,
    },
    {
      term: "you maintain",
      mine: heddle.artifact,
      theirs: rival.artifact,
    },
    {
      term: "swap the model",
      mine: heddle.modelSwap,
      theirs: rival.modelSwap,
      prose: true,
    },
    {
      term: "in this use case",
      mine: heddle.impls[useCase.id].note,
      theirs: isUnsupported(theirs) ? theirs.unsupported : theirs.note,
      prose: true,
    },
  ];

  return (
    <footer
      style={{
        flexShrink: 0,
        borderTop: "1px solid var(--border-hairline)",
        background: "var(--surface-chrome)",
        backdropFilter: "blur(var(--blur-chrome))",
      }}
    >
      <div className="hd-compare-ledger-wrap">
        <table className="hd-compare-ledger">
          <caption className="sr-only">
            heddle compared with {rival.name}
          </caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Property</span>
              </th>
              <th
                scope="col"
                style={{
                  fontSize: "var(--fs-xs)",
                  fontWeight: "var(--fw-semibold)",
                  color: "var(--brand-pink)",
                }}
              >
                heddle
              </th>
              <th
                scope="col"
                style={{
                  fontSize: "var(--fs-xs)",
                  fontWeight: "var(--fw-semibold)",
                  color: "var(--text-strong)",
                }}
              >
                {rival.name}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ term, mine, theirs, prose }) => {
              const style = {
                fontFamily: prose ? "var(--font-sans)" : "var(--font-mono)",
                fontSize: "var(--fs-xs)",
                lineHeight: "var(--lh-relaxed)",
              };
              return (
                <tr key={term}>
                  <th
                    scope="row"
                    className="hd-eyebrow"
                    style={{ whiteSpace: "nowrap" }}
                  >
                    {term}
                  </th>
                  <td
                    data-side="heddle"
                    style={{ ...style, color: "var(--text-strong)" }}
                  >
                    {mine}
                  </td>
                  <td
                    data-side={rival.name}
                    style={{ ...style, color: "var(--text-muted)" }}
                  >
                    {theirs}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p
        style={{
          display: "flex",
          gap: "var(--space-3)",
          margin: 0,
          padding: "var(--space-3) var(--space-5)",
          borderTop: "1px solid var(--border-hairline)",
          fontSize: "var(--fs-xs)",
          lineHeight: "var(--lh-relaxed)",
          color: "var(--text-muted)",
        }}
      >
        <span
          aria-hidden
          style={{ color: "var(--brand-pink)", flex: "0 0 auto", marginTop: 2 }}
        >
          <Icon name="scroll-text" size={14} />
        </span>
        <span>
          Every column is the shortest version that framework&apos;s own
          documentation would write, checked against its current release. Where
          one has no equivalent it says so rather than inventing a version
          nobody would write. Think a column is unfair?{" "}
          <a
            href={`${GITHUB_URL}/issues/new`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--text-body)", textDecoration: "underline" }}
          >
            Open an issue
          </a>{" "}
          and it gets fixed.
        </span>
      </p>
    </footer>
  );
}
