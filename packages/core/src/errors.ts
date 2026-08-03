/** What went wrong, whatever was thrown — the message, or the value as text. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class CompileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CompileError';
  }
}

export class RunError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RunError';
  }
}

export class SpecError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SpecError';
  }
}

export class ToolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolError';
  }
}

export class PluginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PluginError';
  }
}

export class SandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SandboxError';
  }
}

export class LLMError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LLMError';
  }
}

/**
 * Something is wrong with what was to go in a workspace.
 *
 * Its own name rather than `SandboxError`, because a mount is refused whether
 * or not `--safe` is on: where a run's files come from is not a question about
 * confinement, and a message blaming the sandbox for a `--mount` typo would
 * send the reader to the wrong flag.
 */
export class WorkspaceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

/**
 * Something is wrong with a `.heddle` archive, on either side of it.
 *
 * One class for packing and unpacking, because the two are one contract: what
 * `heddle bundle` refuses to write is what `heddle run` would have refused to
 * read. Distinct from `WorkspaceError` because a bundle is a file in transit,
 * not a workspace being assembled — and the unpack side treats its input as
 * hostile, which no workspace message should imply about the operator's own
 * mounts.
 */
export class BundleError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BundleError';
  }
}

/**
 * This machine does not have what the agent declared it needs.
 *
 * Not a `BundleError`, though the declaration usually arrives in one: nothing
 * is wrong with the file. The same bundle runs on the machine next to this one,
 * and the fix is an install here rather than a repack there. Not a `ToolError`
 * either — that one means the flow named a tool heddle cannot find, where this
 * means heddle found everything it ships and the machine is missing the rest.
 */
export class RequirementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RequirementError';
  }
}

export class SessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionError';
  }
}

/**
 * Two writers reached one session, and the second one lost.
 *
 * Its own class rather than a `SessionError` with a distinguishing message,
 * because it is the one session failure a caller can do something about: a
 * conflict means re-read and retry, where every other one means stop. The
 * server maps it to 409 for exactly that reason.
 */
export class SessionConflictError extends SessionError {
  constructor(
    readonly sessionId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `session "${sessionId}" moved on: expected version ${expected}, found ` +
        `${actual}. Something else appended to this conversation while this ` +
        `run was in flight — read it again and decide whether the turn still ` +
        `makes sense before writing.`,
    );
    this.name = 'SessionConflictError';
  }
}
