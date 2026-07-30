/* Every framework has to implement every one of these, and the compiler is
   what enforces it — a column with a gap in it would throw at render. */
export type UseCaseId = "research" | "guardrail" | "routing";

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
  impls: Record<UseCaseId, Implementation>;
}

export interface UseCase {
  id: UseCaseId;
  title: string;
  blurb: string;
}

export function countLines(implementation: Implementation): number {
  return implementation.files.reduce(
    (total, file) => total + file.source.replace(/\n$/, "").split("\n").length,
    0,
  );
}
