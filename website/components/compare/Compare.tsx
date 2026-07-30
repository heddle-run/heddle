"use client";

import Link from "next/link";
import { useState } from "react";
import CodePane from "./CodePane";
import FileTree from "./FileTree";
import Wordmark from "../Wordmark";
import { useTheme } from "@/lib/theme";
import { Icon, Select, ThemeToggle } from "@/ds";
import { GITHUB_URL } from "@/lib/constants";
import {
  RIVALS,
  USE_CASES,
  countLines,
  heddle,
  type Framework,
  type Implementation,
  type UseCaseId,
} from "@/lib/compare";

export default function Compare() {
  const { dark, toggle } = useTheme();

  const [useCase, setUseCase] = useState(USE_CASES[0]);
  const [rival, setRival] = useState<Framework>(RIVALS[0]);

  const left = heddle.impls[useCase.id];
  const right = rival.impls[useCase.id];

  return (
    <div className="hd-playground">
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 20,
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--space-3) var(--space-5)",
          padding: "var(--space-3) var(--space-5)",
          borderBottom: "1px solid var(--border-hairline)",
          background: "var(--surface-chrome)",
          backdropFilter: "blur(var(--blur-chrome))",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
          }}
        >
          <Link href="/" aria-label="heddle — home">
            <Wordmark size="sm" />
          </Link>
          <span
            aria-hidden
            style={{
              width: 1,
              height: 16,
              background: "var(--border-default)",
            }}
          />
          <span className="hd-eyebrow">Compare</span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            minWidth: 0,
          }}
        >
          <label className="hd-eyebrow" htmlFor="compare-use-case">
            Use case
          </label>
          <Select
            id="compare-use-case"
            value={useCase.title}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
              const next = USE_CASES.find(
                (candidate) => candidate.title === event.target.value,
              );
              if (next) setUseCase(next);
            }}
            options={USE_CASES.map((candidate) => candidate.title)}
            style={{ width: 230, flex: "0 0 auto" }}
          />

          <span
            className="hd-playground-blurb"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "var(--fs-xs)",
              color: "var(--text-muted)",
            }}
          >
            {useCase.blurb}
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            marginLeft: "auto",
          }}
        >
          <label className="hd-eyebrow" htmlFor="compare-framework">
            Against
          </label>
          <Select
            id="compare-framework"
            value={rival.name}
            onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
              const next = RIVALS.find(
                (candidate) => candidate.name === event.target.value,
              );
              if (next) setRival(next);
            }}
            options={RIVALS.map((candidate) => candidate.name)}
            style={{ width: 200, flex: "0 0 auto" }}
          />
          <ThemeToggle dark={dark} onToggle={toggle} />
        </div>
      </header>

      <div
        id="panes"
        tabIndex={-1}
        aria-label="The same use case, two frameworks"
        className="hd-playground-body"
      >
        <Pane framework={heddle} implementation={left} accent />
        <Pane framework={rival} implementation={right} />
      </div>

      <Ledger useCase={useCase.id} rival={rival} />
    </div>
  );
}

function Pane({
  framework,
  implementation,
  accent = false,
}: {
  framework: Framework;
  implementation: Implementation;
  accent?: boolean;
}) {
  const [name, setName] = useState(implementation.files[0].name);

  /* The selected file is keyed by name, and the names change with the use
     case and the framework, so fall back to the first file rather than
     rendering nothing when the selection no longer exists. */
  const file =
    implementation.files.find((candidate) => candidate.name === name) ??
    implementation.files[0];

  const lines = countLines(implementation);

  return (
    <section aria-label={framework.name} className="hd-playground-pane">
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
          {lines} {lines === 1 ? "line" : "lines"} ·{" "}
          {implementation.files.length}{" "}
          {implementation.files.length === 1 ? "file" : "files"} ·{" "}
          {framework.packages.length}{" "}
          {framework.packages.length === 1 ? "package" : "packages"}
        </span>
      </div>

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
          gap: "var(--space-3)",
          padding: "var(--space-3) var(--space-5)",
          borderTop: "1px solid var(--border-hairline)",
          background: "var(--surface-panel)",
          overflowX: "auto",
        }}
      >
        <span
          aria-hidden
          style={{ color: "var(--brand-pink)", flex: "0 0 auto", marginTop: 1 }}
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
    </section>
  );
}

function Ledger({ useCase, rival }: { useCase: UseCaseId; rival: Framework }) {
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
      mine: heddle.impls[useCase].note,
      theirs: rival.impls[useCase].note,
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
          documentation would write, checked against its current release. Think
          one is unfair?{" "}
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
