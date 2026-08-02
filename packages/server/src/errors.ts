import {
  CompileError,
  LLMError,
  MiddlewareError,
  PluginError,
  RunError,
  SandboxError,
  SessionConflictError,
  SessionError,
  SpecError,
  ToolError,
} from '@heddle/core';

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

const CALLER_FAULT_ERRORS = [SpecError, CompileError, PluginError];

const SERVER_FAULT_ERRORS = [
  MiddlewareError,
  SandboxError,
  RunError,
  ToolError,
  LLMError,
];

export function toErrorResponse(err: unknown): {
  status: number;
  body: ErrorBody;
} {
  if (err instanceof HttpError) {
    return errorResponse(err.status, err.type, err.message);
  }
  // Before the two lists below, and its own branch rather than an entry in
  // them: a conflict is the one failure here a caller can act on — re-read the
  // conversation and decide whether the turn still makes sense — so it gets a
  // status meaning "try again with fresh information" rather than 400 or 500.
  if (err instanceof SessionConflictError) {
    return errorResponse(409, err.name, err.message);
  }
  if (err instanceof SessionError) {
    return errorResponse(400, err.name, err.message);
  }
  if (isOneOf(err, SERVER_FAULT_ERRORS)) {
    return errorResponse(500, err.name, err.message);
  }
  if (isOneOf(err, CALLER_FAULT_ERRORS)) {
    return errorResponse(400, err.name, err.message);
  }

  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : 'Error';
  return errorResponse(500, name, message);
}

function isOneOf(
  err: unknown,
  kinds: Array<new (...args: never[]) => Error>,
): err is Error {
  return kinds.some((kind) => err instanceof kind);
}

function errorResponse(
  status: number,
  type: string,
  message: string,
): { status: number; body: ErrorBody } {
  return { status, body: { error: { type, message } } };
}
