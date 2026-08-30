import {
  BundleError,
  CompileError,
  LLMError,
  messageOf,
  MiddlewareError,
  PluginError,
  RunError,
  SandboxError,
  SessionConflictError,
  SessionError,
  SpecError,
  ToolError,
} from '@heddle-run/core';

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

// `BundleError` is caller-fault here even though the CLI treats it as its
// user's: over HTTP a bundle only ever arrives in a request, so a manifest
// that will not validate or an archive that will not extract is the sender's
// to fix.
const CALLER_FAULT_ERRORS = [SpecError, CompileError, PluginError, BundleError];

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

  const message = messageOf(err);
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
