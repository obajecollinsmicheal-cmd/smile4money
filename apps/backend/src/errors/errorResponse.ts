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
 *   { "error": { "code": "SOME_CODE", "message": "human-readable text" } }
 *
 * documented in docs/api-reference.md. Route handlers should build their
 * error body with `errorEnvelope()` below rather than hand-rolling one.
 */

/** Stable machine-readable error codes. Add new ones here as they're needed — keep this the single source of truth. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
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
    [extra: string]: unknown;
  };
}

/** Base URL for the API reference documentation. */
const DOCS_BASE_URL = 'https://docs.example.com/api-reference.md';

/** A recovery suggestion: an actionable next step plus a link to relevant docs. */
export interface RecoverySuggestion {
  suggestion: string;
  docsUrl: string;
}

/**
 * Registry of actionable recovery guidance keyed by {@link ErrorCode} and by
 * known error class names (e.g. `RateLimitError`). Each entry tells the caller
 * *how to fix* the problem, not just what went wrong, and links to the
 * relevant section of docs/api-reference.md.
 */
export const recoverySuggestions: Record<string, RecoverySuggestion> = {
  [ErrorCode.VALIDATION_ERROR]: {
    suggestion:
      'Check the request body against the documented schema, correct the invalid or missing fields, and retry the request.',
    docsUrl: `${DOCS_BASE_URL}#validation-error`,
  },
  [ErrorCode.UNAUTHORIZED]: {
    suggestion:
      'Provide a valid authentication token in the Authorization header (or refresh your token) and retry the request.',
    docsUrl: `${DOCS_BASE_URL}#unauthorized`,
  },
  [ErrorCode.NOT_FOUND]: {
    suggestion:
      'Verify the resource identifier in the request URL is correct and that the resource exists, then retry.',
    docsUrl: `${DOCS_BASE_URL}#not-found`,
  },
  [ErrorCode.CONFLICT]: {
    suggestion:
      'Fetch the latest state of the resource, reconcile your change with it, and retry the request.',
    docsUrl: `${DOCS_BASE_URL}#conflict`,
  },
  [ErrorCode.RATE_LIMITED]: {
    suggestion:
      'You have exceeded the rate limit. Wait for the period indicated by the Retry-After header, then retry with exponential backoff.',
    docsUrl: `${DOCS_BASE_URL}#rate-limited`,
  },
  [ErrorCode.INTERNAL_ERROR]: {
    suggestion:
      'This is a server-side error. Retry the request after a short delay; if it persists, contact support with the request ID.',
    docsUrl: `${DOCS_BASE_URL}#internal-error`,
  },
  RateLimitError: {
    suggestion:
      'You have exceeded the rate limit. Wait for the period indicated by the Retry-After header, then retry with exponential backoff.',
    docsUrl: `${DOCS_BASE_URL}#rate-limited`,
  },
  RpcTimeoutError: {
    suggestion:
      'The upstream RPC call timed out. Retry the request; if timeouts persist, check the RPC provider status and configuration.',
    docsUrl: `${DOCS_BASE_URL}#rpc-timeout`,
  },
  ProviderSchemaError: {
    suggestion:
      'The upstream provider returned an unexpected response shape. Verify the provider configuration and retry; if it persists, report the provider and response to support.',
    docsUrl: `${DOCS_BASE_URL}#provider-schema-error`,
  },
};

/**
 * Resolves recovery guidance for a given error code or error class name.
 * Falls back to the generic {@link ErrorCode.INTERNAL_ERROR} guidance when the
 * key is unknown so callers always receive an actionable suggestion.
 */
export function getRecoverySuggestion(key: string): RecoverySuggestion {
  return recoverySuggestions[key] ?? recoverySuggestions[ErrorCode.INTERNAL_ERROR];
}

/**
 * Builds the standard `{ error: { code, message } }` response body.
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
  const recovery = getRecoverySuggestion(code);
  return {
    error: {
      code,
      message,
      suggestion: recovery.suggestion,
      docsUrl: recovery.docsUrl,
      ...extra,
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
