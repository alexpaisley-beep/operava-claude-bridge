/**
 * Stable, machine-readable error model.
 *
 * Every error surfaced through the MCP tool interface carries one of these
 * codes plus a human-readable message. ChatGPT (and any other MCP caller)
 * can branch on `code` without parsing prose.
 */

export const ERROR_CODES = [
  'REPOSITORY_NOT_FOUND',
  'REPOSITORY_DISABLED',
  'BRANCH_NOT_FOUND',
  'PR_NOT_FOUND',
  'TASK_NOT_FOUND',
  'TASK_ALREADY_RUNNING',
  'TASK_NOT_CONTINUABLE',
  'TASK_CANCELLED',
  'BRANCH_BUSY',
  'IDEMPOTENCY_CONFLICT',
  'CLAUDE_AUTH_ERROR',
  'CLAUDE_EXECUTION_FAILED',
  'CLAUDE_SESSION_UNAVAILABLE',
  'CLAUDE_TIMEOUT',
  'GIT_AUTH_ERROR',
  'GIT_CONFLICT',
  'GIT_ERROR',
  'GITHUB_API_ERROR',
  'WORKFLOW_NOT_FOUND',
  'WORKFLOW_NOT_ALLOWED',
  'WORKFLOW_FAILED',
  'WORKFLOW_TIMEOUT',
  'WORKFLOW_RUN_NOT_FOUND',
  'PERMISSION_DENIED',
  'EXPECTED_HEAD_MISMATCH',
  'MERGE_BLOCKED',
  'MODEL_NOT_ALLOWED',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'NOT_AUTHORIZED',
  'WORKER_LOST',
  'WORKER_SHUTDOWN',
  'WORKSPACE_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class BridgeError extends Error {
  readonly code: ErrorCode;
  /** Extra machine-oriented detail, safe to return to the MCP caller. */
  readonly detail?: string;
  readonly httpStatus: number;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { detail?: string; httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'BridgeError';
    this.code = code;
    this.detail = opts.detail;
    this.httpStatus = opts.httpStatus ?? defaultHttpStatus(code);
  }

  toPayload(): { error: { code: ErrorCode; message: string; detail?: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.detail !== undefined ? { detail: this.detail } : {}),
      },
    };
  }
}

function defaultHttpStatus(code: ErrorCode): number {
  switch (code) {
    case 'REPOSITORY_NOT_FOUND':
    case 'BRANCH_NOT_FOUND':
    case 'PR_NOT_FOUND':
    case 'TASK_NOT_FOUND':
    case 'WORKFLOW_NOT_FOUND':
    case 'WORKFLOW_RUN_NOT_FOUND':
      return 404;
    case 'TASK_ALREADY_RUNNING':
    case 'TASK_NOT_CONTINUABLE':
    case 'TASK_CANCELLED':
    case 'BRANCH_BUSY':
    case 'IDEMPOTENCY_CONFLICT':
    case 'EXPECTED_HEAD_MISMATCH':
    case 'MERGE_BLOCKED':
      return 409;
    case 'VALIDATION_ERROR':
    case 'MODEL_NOT_ALLOWED':
    case 'WORKFLOW_NOT_ALLOWED':
      return 400;
    case 'PERMISSION_DENIED':
    case 'REPOSITORY_DISABLED':
      return 403;
    case 'NOT_AUTHORIZED':
      return 401;
    case 'RATE_LIMITED':
      return 429;
    default:
      return 500;
  }
}

export function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError;
}

/** Wrap any thrown value into a BridgeError without losing the original cause. */
export function toBridgeError(err: unknown, fallback: ErrorCode = 'INTERNAL_ERROR'): BridgeError {
  if (isBridgeError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new BridgeError(fallback, message, { cause: err });
}
