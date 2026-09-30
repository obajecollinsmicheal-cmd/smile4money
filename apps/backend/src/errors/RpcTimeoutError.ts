/**
 * RpcTimeoutError is thrown when a Soroban RPC call exceeds its configured
 * timeout (#1718). Callers should catch this specifically — a hanging RPC
 * node is a distinct, typically-retryable failure mode from a malformed
 * request or an RPC error response, and previously surfaced only as axios's
 * generic `ECONNABORTED` error, indistinguishable from any other network
 * failure.
 */
export class RpcTimeoutError extends Error {
  constructor(
    message: string = 'Stellar RPC request timed out',
    public readonly timeoutMs?: number,
  ) {
    super(message);
    this.name = 'RpcTimeoutError';
    Object.setPrototypeOf(this, RpcTimeoutError.prototype);
  }

  /**
   * Check if an error is an RpcTimeoutError.
   * Useful for instanceof checks in catch blocks.
   */
  static isRpcTimeoutError(error: unknown): error is RpcTimeoutError {
    return error instanceof RpcTimeoutError;
  }
}
