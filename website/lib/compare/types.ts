/* Every framework has to answer for every one of these, and the compiler is
   what enforces it — a column with a gap in it would throw at render.

   Answering is not the same as implementing. Where a framework has no honest
   equivalent, it says so with an Unsupported entry that gives the reason. That
   keeps the gap a written claim someone can argue with, rather than a missing
   key nobody notices. */
export type UseCaseId =
  | "tool-and-plugin"
  | "guardrail"
  | "routing"
  | "agent"
  | "research"
  | "shell"
  | "skills"
  | "ag-ui";

export interface CompareFile {
  name: string;
  language: string;
  source: string;
}

export interface Implementation {
  /** Every file a reader would have to write and keep. */
  files: CompareFile[];
  /** The command that runs it, once the files exist. */
  run: string;
  /** One sentence: how this framework expresses this particular use case. */
  note: string;
}

/** A use case this framework has no honest equivalent for. */
export interface Unsupported {
  /** What the framework offers instead, and why it is not the same thing.
      Shown where the code would be, and in the ledger's last row. */
  unsupported: string;
}

/** What a framework says about one use case: how it does it, or why it does
    not do it. */
export type Cell = Implementation | Unsupported;

export function isUnsupported(cell: Cell): cell is Unsupported {
  return "unsupported" in cell;
}

export interface Framework {
  id: string;
  name: string;
  /** What a reader installs before writing a line. */
  install: string;
  /** The distributions that install pulls in directly. */
  packages: string[];
  /** What the reader ends up maintaining. */
  artifact: string;
  /** What changes to point the same program at another provider. */
  modelSwap: string;
  docs: string;
  /** The fair summary of the framework's approach. */
  note: string;
  impls: Record<UseCaseId, Cell>;
}

/** heddle's own column, which never has a gap. The comparison only holds use
    cases heddle can express, so an Unsupported entry on this side would be a
    bug rather than a fact about a framework — and this type is what stops one
    being written. */
export interface Reference extends Framework {
  impls: Record<UseCaseId, Implementation>;
}

export interface UseCase {
  id: UseCaseId;
  title: string;
  blurb: string;
  /** The playground example that is this use case in heddle, by its id in
      lib/playground.ts. It is what the comparison hands to the editor, so a
      reader can run the left-hand column rather than only read it. */
  example: string;
}

export function countLines(implementation: Implementation): number {
  return implementation.files.reduce(
    (total, file) => total + file.source.replace(/\n$/, "").split("\n").length,
    0,
  );
}
