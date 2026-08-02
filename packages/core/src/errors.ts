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
