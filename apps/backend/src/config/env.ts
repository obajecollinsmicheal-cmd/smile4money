/**
 * Environment configuration for the smile4money Oracle Service.
 *
 * All environment variables are read and validated once at startup.
 * Invalid or missing required values throw immediately so the process
 * fails fast rather than misbehaving at runtime.
 *
 * Usage:
 *   import { env } from './config/env';
 *   console.log(env.pollingMaxRetries); // => 5
 */

import { resolveNetworkConfig } from './network.js';

/** Default maximum number of poll retries before a job is moved to the DLQ. */
const DEFAULT_POLLING_MAX_RETRIES = 5;

/** Default interval (ms) at which queue metrics are refreshed. */
const DEFAULT_QUEUE_METRICS_INTERVAL_MS = 15_000;

/** Default interval (ms) at which queue progress is sampled for stall detection. */
const DEFAULT_QUEUE_STALL_INTERVAL_MS = 30_000;

/** Default number of consecutive no-progress intervals before a stall alert. */
const DEFAULT_QUEUE_STALL_THRESHOLD = 3;

/**
 * Parses POLLING_MAX_RETRIES from the environment.
 *
 * Rules:
 *  - If the variable is absent, the default (5) is used.
 *  - If the variable is present but not a valid integer, startup fails.
 *  - If the parsed value is zero or negative, startup fails.
 *
 * @throws {Error} when the value is non-integer, zero, or negative.
 */
function parsePollingMaxRetries(): number {
  const raw = process.env.POLLING_MAX_RETRIES;

  if (raw === undefined || raw === '') {
    return DEFAULT_POLLING_MAX_RETRIES;
  }

  const parsed = parseInt(raw, 10);

  if (isNaN(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `POLLING_MAX_RETRIES must be a positive integer, got: "${raw}"`
    );
  }

  if (parsed <= 0) {
    throw new Error(
      `POLLING_MAX_RETRIES must be greater than zero, got: ${parsed}`
    );
  }

  return parsed;
}

/**
 * Parses a positive-integer environment variable, falling back to `defaultValue`
 * when the variable is absent or empty.
 *
 * Rules:
 *  - If the variable is absent or empty, the default is used.
 *  - If the variable is present but not a valid integer, startup fails.
 *  - If the parsed value is zero or negative, startup fails.
 *
 * @throws {Error} when the value is non-integer, zero, or negative.
 */
function parsePositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = parseInt(raw, 10);

  if (isNaN(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer, got: "${raw}"`);
  }

  if (parsed <= 0) {
    throw new Error(`${name} must be greater than zero, got: ${parsed}`);
  }

  return parsed;
}

export interface Env {
  /** Stellar network to connect to (e.g. "testnet", "mainnet"). */
  stellarNetwork: string;

  /** Stellar RPC endpoint URL. */
  stellarRpcUrl: string;

  /** Deployed escrow contract ID. */
  contractEscrow: string;

  /** Deployed oracle contract ID. */
  contractOracle: string;

  /** Lichess API token for game result polling. */
  lichessApiToken: string;

  /** Chess.com API key for game result polling. */
  chessdotcomApiKey: string;

  /**
   * Maximum number of times the oracle service polls the chess platform API
   * for a game result before moving the job to the dead-letter queue (DLQ).
   *
   * Sourced from POLLING_MAX_RETRIES. Defaults to 5 when unset.
   * Must be a positive integer — zero and negative values are rejected at startup.
   */
  pollingMaxRetries: number;

  /**
   * How often (in milliseconds) queue monitoring metrics — depth, age of the
   * oldest entry and success rate — are refreshed.
   *
   * Sourced from QUEUE_METRICS_INTERVAL_MS. Defaults to 15000 when unset.
   * Must be a positive integer.
   */
  queueMetricsIntervalMs: number;

  /**
   * Sampling interval (in milliseconds) used by queue stall detection to
   * compare progress between consecutive intervals.
   *
   * Sourced from QUEUE_STALL_INTERVAL_MS. Defaults to 30000 when unset.
   * Must be a positive integer.
   */
  queueStallIntervalMs: number;

  /**
   * Number of consecutive no-progress intervals after which the queue is
   * considered stalled and an alert is sent.
   *
   * Sourced from QUEUE_STALL_THRESHOLD. Defaults to 3 when unset.
   * Must be a positive integer.
   */
  queueStallThreshold: number;
}

/**
 * Loads and validates all environment variables required by the Oracle Service.
 * Throws on the first invalid value so the process fails fast at startup.
 */
function loadEnv(): Env {
  // Network, RPC endpoint and contract ids come from the canonical table in
  // environments.toml; conflicting overrides throw here (#118).
  const network = resolveNetworkConfig(process.env);
  return {
    stellarNetwork: network.network,
    stellarRpcUrl: network.rpcUrl,
    contractEscrow: network.contracts.escrow ?? '',
    contractOracle: network.contracts.oracle ?? '',
    lichessApiToken: process.env.LICHESS_API_TOKEN ?? '',
    chessdotcomApiKey: process.env.CHESSDOTCOM_API_KEY ?? '',
    pollingMaxRetries: parsePollingMaxRetries(),
    queueMetricsIntervalMs: parsePositiveInt(
      'QUEUE_METRICS_INTERVAL_MS',
      DEFAULT_QUEUE_METRICS_INTERVAL_MS
    ),
    queueStallIntervalMs: parsePositiveInt(
      'QUEUE_STALL_INTERVAL_MS',
      DEFAULT_QUEUE_STALL_INTERVAL_MS
    ),
    queueStallThreshold: parsePositiveInt(
      'QUEUE_STALL_THRESHOLD',
      DEFAULT_QUEUE_STALL_THRESHOLD
    ),
  };
}

/**
 * Validated, typed environment configuration.
 * Evaluated once at module load time — any startup error surfaces immediately.
 */
export const env: Env = loadEnv();
