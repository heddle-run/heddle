"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Build, { BuildStatusBar, EngineNotice } from "./Build";
import Wordmark from "../Wordmark";
import { ComparePanes, CompareLedger } from "../compare/Compare";
import { useTheme } from "@/lib/theme";
import { usePlayground } from "@/lib/use-playground";
import { Badge, Button, Icon, Select, ThemeToggle } from "@/ds";
import { HOME_URL } from "@/lib/constants";
import { EXAMPLES, exampleById, type Example } from "@/lib/playground";
import {
  RIVALS,
  USE_CASES,
  type Framework,
  type UseCase,
} from "@/lib/compare";

type View = "build" | "compare";

const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "build", label: "Build", icon: "braces" },
  { id: "compare", label: "Compare", icon: "columns2" },
];

/* The prerendered HTML is the Build view, because a static export has no
   query to render against. Reading the address in a layout effect switches
   before the browser paints, so a link to a comparison opens on it rather
   than flashing the editor first. On the server there is no layout to
   measure and React says so loudly, hence the pair. */
const useBrowserLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The playground: an editor with an engine behind it, and the same use cases
 * written in other frameworks, as two views of one application.
 *
 * They were two pages once. They are one because they answer the same
 * question in sequence — is this better than what I already use, and does it
 * actually run — and because a comparison the reader cannot run is only an
 * assertion. Every heddle column in the comparison is a playground example,
 * and the button in that column hands it to the editor.
 */
export default function Playground() {
  const { dark, toggle } = useTheme();

  const pg = usePlayground();
  const [view, setView] = useState<View>("build");
  const [useCase, setUseCase] = useState<UseCase>(USE_CASES[0]);
  const [rival, setRival] = useState<Framework>(RIVALS[0]);

  /* The view is in the address, so a particular comparison can be linked to.
     This is a static export with no server to read the query, and reading it
     during render would not survive hydration — so it is read once, on mount,
     and written back with replaceState, which keeps the address in step
     without a navigation. */
  const read = useRef(false);

  useBrowserLayoutEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.get("view") === "compare") setView("compare");

    const useCaseParam = USE_CASES.find((c) => c.id === params.get("case"));
    if (useCaseParam) setUseCase(useCaseParam);

    const rivalParam = RIVALS.find((r) => r.id === params.get("against"));
    if (rivalParam) setRival(rivalParam);

    read.current = true;
  }, []);

  useEffect(() => {
    if (!read.current) return;

    const params = new URLSearchParams(window.location.search);
    if (view === "compare") {
      params.set("view", "compare");
      params.set("case", useCase.id);
      params.set("against", rival.id);
    } else {
      for (const key of ["view", "case", "against"]) params.delete(key);
    }

    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}`,
    );
  }, [view, useCase, rival]);

  /* Handing a comparison to the editor moves the reader to another view, so
     it also moves focus there — otherwise the keyboard is left on a button
     that is no longer on the page. */
  const handedOver = useRef(false);

  const openInEditor = () => {
    const example = exampleById(useCase.example);
    if (example) pg.load(example);
    handedOver.current = true;
    setView("build");
  };

  useEffect(() => {
    if (view !== "build" || !handedOver.current) return;
    handedOver.current = false;
    document.getElementById("editors")?.focus();
  }, [view]);

  const building = view === "build";

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
          <a href={HOME_URL} aria-label="heddle — home">
            <Wordmark size="sm" />
          </a>
          <span
            aria-hidden
            style={{
              width: 1,
              height: 16,
              background: "var(--border-default)",
            }}
          />
          <ViewSwitch view={view} onSelect={setView} />
        </div>

        {building ? (
          <ExamplePicker
            current={pg.example}
            onSelect={pg.load}
            disabled={pg.busy}
          />
        ) : (
          <UseCasePicker current={useCase} onSelect={setUseCase} />
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            marginLeft: "auto",
          }}
        >
          {building ? (
            <>
              <Button
                shape="rounded"
                variant={pg.busy ? "accent" : "solid"}
                icon={pg.busy ? "square" : "play"}
                onClick={pg.busy ? pg.stop : pg.run}
              >
                {pg.busy ? "Stop" : "Run"}
              </Button>
              <Button
                shape="rounded"
                variant="subtle"
                icon="check-check"
                onClick={pg.check}
                disabled={pg.busy}
              >
                Validate
              </Button>
            </>
          ) : (
            <RivalPicker current={rival} onSelect={setRival} />
          )}
          <ThemeToggle dark={dark} onToggle={toggle} />
        </div>
      </header>

      {building && <EngineNotice reachable={pg.reachable} />}

      <div
        id="panes"
        tabIndex={-1}
        aria-label={
          building
            ? "The specification and the run"
            : "The same use case, two frameworks"
        }
        className="hd-playground-body"
      >
        {building ? (
          <Build pg={pg} />
        ) : (
          <ComparePanes
            useCase={useCase}
            rival={rival}
            onOpen={openInEditor}
          />
        )}
      </div>

      {building ? (
        <BuildStatusBar
          capabilities={pg.capabilities}
          reachable={pg.reachable}
          codeAllowed={pg.codeAllowed}
        />
      ) : (
        <CompareLedger useCase={useCase} rival={rival} />
      )}
    </div>
  );
}

function ViewSwitch({
  view,
  onSelect,
}: {
  view: View;
  onSelect: (view: View) => void;
}) {
  return (
    <div
      role="group"
      aria-label="View"
      style={{
        display: "flex",
        gap: 2,
        padding: 2,
        border: "1px solid var(--border-hairline)",
        borderRadius: "var(--radius-full)",
      }}
    >
      {VIEWS.map(({ id, label, icon }) => {
        const selected = id === view;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-2)",
              minHeight: 30,
              padding: "0 var(--space-4)",
              border: 0,
              borderRadius: "var(--radius-full)",
              background: selected ? "var(--bg-sunken)" : "transparent",
              color: selected ? "var(--text-strong)" : "var(--text-muted)",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
              fontSize: "var(--fs-2xs)",
              fontWeight: selected
                ? "var(--fw-semibold)"
                : "var(--fw-medium)",
              textTransform: "uppercase",
              letterSpacing: "var(--tracking-widest)",
              transition:
                "color var(--dur-base) var(--ease-standard), background-color var(--dur-base) var(--ease-standard)",
            }}
          >
            <span
              aria-hidden
              style={{
                display: "inline-flex",
                color: selected ? "var(--brand-pink)" : "currentColor",
              }}
            >
              <Icon name={icon} size={13} />
            </span>
            {label}
          </button>
        );
      })}
    </div>
  );
}

function ExamplePicker({
  current,
  onSelect,
  disabled,
}: {
  current: Example;
  onSelect: (example: Example) => void;
  disabled: boolean;
}) {
  return (
    <Picker label="Example" htmlFor="playground-example" blurb={current.blurb}>
      <Select
        id="playground-example"
        value={current.title}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          const next = EXAMPLES.find((e) => e.title === event.target.value);
          if (next) onSelect(next);
        }}
        options={EXAMPLES.map((example) => example.title)}
        disabled={disabled}
        style={{ width: 260, flex: "0 0 auto" }}
      />

      {current.needsKey && (
        <Badge tone="neutral" uppercase title="Needs your own model credential">
          key
        </Badge>
      )}
    </Picker>
  );
}

function UseCasePicker({
  current,
  onSelect,
}: {
  current: UseCase;
  onSelect: (useCase: UseCase) => void;
}) {
  return (
    <Picker label="Use case" htmlFor="compare-use-case" blurb={current.blurb}>
      <Select
        id="compare-use-case"
        value={current.title}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          const next = USE_CASES.find(
            (candidate) => candidate.title === event.target.value,
          );
          if (next) onSelect(next);
        }}
        options={USE_CASES.map((candidate) => candidate.title)}
        style={{ width: 230, flex: "0 0 auto" }}
      />
    </Picker>
  );
}

function RivalPicker({
  current,
  onSelect,
}: {
  current: Framework;
  onSelect: (framework: Framework) => void;
}) {
  return (
    <>
      <label className="hd-eyebrow" htmlFor="compare-framework">
        Against
      </label>
      <Select
        id="compare-framework"
        value={current.name}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          const next = RIVALS.find(
            (candidate) => candidate.name === event.target.value,
          );
          if (next) onSelect(next);
        }}
        options={RIVALS.map((candidate) => candidate.name)}
        style={{ width: 200, flex: "0 0 auto" }}
      />
    </>
  );
}

/** A labelled select in the bar, with the one-line description beside it. */
function Picker({
  label,
  htmlFor,
  blurb,
  children,
}: {
  label: string;
  htmlFor: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        minWidth: 0,
      }}
    >
      <label className="hd-eyebrow" htmlFor={htmlFor}>
        {label}
      </label>

      {children}

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
        {blurb}
      </span>
    </div>
  );
}
