import {
  CompileError,
  LLMError,
  PluginError,
  RunError,
  SandboxError,
  SpecError,
  ToolError,
} from '@heddle/core';

/** An error carrying an explicit HTTP status, raised by the request layer. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = 'BadRequest',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ErrorBody {
  error: {
    type: string;
    message: string;
  };
}

/**
 * Map an error onto an HTTP status and a structured body.
 *
 * Spec and compile failures are the caller's fault (the flow they submitted is
 * wrong) and map to 400. Failures that happen while running — a tool exiting
 * non-zero, an LLM call failing — are 500: the request was well-formed, the
 * execution was not successful.
 */
export function toErrorResponse(err: unknown): {
  status: number;
  body: ErrorBody;
} {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { type: err.type, message: err.message } } };
  }

  // PluginError joins these because this server only ever loads plugins that
  // arrived with the request: a module that fails to import, or declares no
  // components, is the caller's broken submission.
  if (
    err instanceof SpecError ||
    err instanceof CompileError ||
    err instanceof PluginError
  ) {
    return {
      status: 400,
      body: { error: { type: err.name, message: err.message } },
    };
  }

  // A sandbox that cannot be built is a fault in how the server was started —
  // a missing bwrap, an unsupported platform — and never something the caller
  // chose, since confinement is not request-configurable.
  if (err instanceof SandboxError) {
    return {
      status: 500,
      body: { error: { type: err.name, message: err.message } },
    };
  }

  if (
    err instanceof RunError ||
    err instanceof ToolError ||
    err instanceof LLMError
  ) {
    return {
      status: 500,
      body: { error: { type: err.name, message: err.message } },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : 'Error';
  return { status: 500, body: { error: { type: name, message } } };
}
