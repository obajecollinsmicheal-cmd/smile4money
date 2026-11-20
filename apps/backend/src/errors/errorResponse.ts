/**
 * Standard API error envelope (#50).
 *
 * Before this module, every route built its own ad-hoc error JSON shape
 * (`{ error: "some string" }`, `{ error: "some string", details, hint }`,
 * `{ error: "unauthorized", message }`, `{ error: "rate_limit_exceeded",
 * message }` — four different shapes for four different concerns). API
 * consumers had no single, reliable field to branch on.
 *
 * Every error response now follows one schema:
 *
 *   { "error": { "code", "message", "suggestion", "documentation" } }
 *
 * documented in docs/api-reference.md. Route handlers should build their
 * error body with `errorEnvelope()` below rather than hand-rolling one.
 */

/** Stable machine-readable error codes. Add new ones here as they're needed — keep this the single source of truth. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    suggestion: string;
    documentation: string;
    [extra: string]: unknown;
  };
}

const ERROR_GUIDANCE: Record<string, string> = {
  VALIDATION_ERROR: 'Check the request fields and correct the invalid or missing values.',
  UNAUTHORIZED: 'Provide a valid, unexpired bearer token and verify its required permissions.',
  FORBIDDEN: 'Ask an administrator to grant the permissions required for this operation.',
  NOT_FOUND: 'Verify the resource identifier and confirm that the resource exists.',
  CONFLICT: 'Refresh the current resource state, then retry with a non-conflicting request.',
  RATE_LIMITED: 'Wait before retrying and use exponential backoff between attempts.',
  INTERNAL_ERROR: 'Retry once; if the problem persists, contact support with the request time.',
};

const ERROR_DOCUMENTATION =
  'https://github.com/obajecollinsmicheal-cmd/smile4money/blob/master/docs/api-reference.md#recovering-from-errors';

/**
 * Builds the standard `{ error: { code, message, suggestion, documentation } }` body.
 *
 * `extra` merges additional diagnostic fields (e.g. a machine-readable
 * `hint`) into the `error` object, never onto the top-level response body —
 * every error response must have exactly one top-level key, `error`.
 */
export function errorEnvelope(
  code: ErrorCode | string,
  message: string,
  extra?: Record<string, unknown>,
): ErrorEnvelope {
  const defaultSuggestion = Object.prototype.hasOwnProperty.call(
    ERROR_GUIDANCE,
    code,
  )
    ? ERROR_GUIDANCE[code]
    : 'Review the error code and message, correct the request, or contact support if it persists.';

  return {
    error: {
      code,
      message,
      ...extra,
      suggestion:
        typeof extra?.suggestion === 'string'
          ? extra.suggestion
          : defaultSuggestion,
      documentation: ERROR_DOCUMENTATION,
    },
  };
}

/**
 * Maps an HTTP status code to the matching {@link ErrorCode}.
 *
 * Several services (`match-service.ts`, `oracle-service.ts`,
 * `validate-game-service.ts`) already decide *which* status a failure maps
 * to (400/404/409/500) but don't carry a semantic label alongside it. This
 * lets route handlers derive a stable `code` from that existing status
 * without every service needing to be rewritten to also return one.
 */
export function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_ERROR;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 422:
      return ErrorCode.VALIDATION_ERROR;
    case 429:
      return ErrorCode.RATE_LIMITED;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}
