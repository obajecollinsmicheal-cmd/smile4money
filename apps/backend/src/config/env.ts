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

/** Default number of days a DLQ entry is retained before automatic eviction. */
const DEFAULT_DLQ_TTL_DAYS = 7;

/** Default interval between DLQ expiration sweeps, in milliseconds (1 hour). */
const DEFAULT_DLQ_EXPIRATION_INTERVAL_MS = 3_600_000;

/** Default base delay for exponential backoff, in milliseconds. */
const DEFAULT_BACKOFF_BASE_DELAY_MS = 1_000;

/** Default maximum delay cap for exponential backoff, in milliseconds. */
const DEFAULT_BACKOFF_MAX_DELAY_MS = 300_000;

/** Default exponential backoff multiplier. */
const DEFAULT_BACKOFF_MULTIPLIER = 2;

/**
 * Parses a required-positive-integer environment variable.
 *
 * Rules:
 *  - If the variable is absent or empty, `defaultValue` is used.
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

/**
 * Parses a required-positive-number environment variable (allows decimals).
 *
 * Rules:
 *  - If the variable is absent or empty, `defaultValue` is used.
 *  - If the variable is present but not a finite number, startup fails.
 *  - If the parsed value is zero or negative, startup fails.
 *
 * @throws {Error} when the value is non-numeric, zero, or negative.
 */
function parsePositiveNumber(name: string, defaultValue: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a positive number, got: "${raw}"`);
  }

  if (parsed <= 0) {
    throw new Error(`${name} must be greater than zero, got: ${parsed}`);
  }

  return parsed;
}

/**
 * Parses DLQ_TTL_DAYS from the environment.
 *
 * @throws {Error} when the value is non-integer, zero, or negative.
 */
function parseDlqTtlDays(): number {
  return parsePositiveInt('DLQ_TTL_DAYS', DEFAULT_DLQ_TTL_DAYS);
}

/**
 * Parses DLQ_EXPIRATION_INTERVAL_MS from the environment.
 *
 * @throws {Error} when the value is non-integer, zero, or negative.
 */
function parseDlqExpirationIntervalMs(): number {
  return parsePositiveInt(
    'DLQ_EXPIRATION_INTERVAL_MS',
    DEFAULT_DLQ_EXPIRATION_INTERVAL_MS
  );
}

/** Per-job-type exponential backoff tuning. */
export interface BackoffConfig {
  /** Base delay before the first retry, in milliseconds. */
  baseDelayMs: number;

  /** Maximum delay cap between retries, in milliseconds. */
  maxDelayMs: number;

  /** Multiplier applied to the delay after each attempt. */
  multiplier: number;
}

/**
 * Normalises a job type into the env-var fragment used for overrides,
 * e.g. "game-result" / "game_result" / "GameResult" => "GAME_RESULT".
 */
function jobTypeEnvKey(jobType: string): string {
  return jobType
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/**
 * Parses per-job-type backoff overrides from BACKOFF_<JOBTYPE>_BASE_DELAY_MS,
 * BACKOFF_<JOBTYPE>_MAX_DELAY_MS and BACKOFF_<JOBTYPE>_MULTIPLIER.
 *
 * Only job types with at least one override variable present are included;
 * missing fields fall back to the global backoff defaults.
 *
 * @throws {Error} when any present override value is invalid.
 */
function parseBackoffOverrides(
  defaults: BackoffConfig
): Record<string, BackoffConfig> {
  const prefix = 'BACKOFF_';
  const suffixes = ['_BASE_DELAY_MS', '_MAX_DELAY_MS', '_MULTIPLIER'] as const;
  const jobTypes = new Set<string>();

  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    for (const suffix of suffixes) {
      if (key.endsWith(suffix) && key.length > prefix.length + suffix.length) {
        jobTypes.add(key.slice(prefix.length, key.length - suffix.length));
        break;
      }
    }
  }

  const overrides: Record<string, BackoffConfig> = {};

  for (const jobType of jobTypes) {
    overrides[jobType] = {
      baseDelayMs: parsePositiveInt(
        `${prefix}${jobType}_BASE_DELAY_MS`,
        defaults.baseDelayMs
      ),
      maxDelayMs: parsePositiveInt(
        `${prefix}${jobType}_MAX_DELAY_MS`,
        defaults.maxDelayMs
      ),
      multiplier: parsePositiveNumber(
        `${prefix}${jobType}_MULTIPLIER`,
        defaults.multiplier
      ),
    };
  }

  return overrides;
}

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
   * Number of days a dead-letter-queue entry is retained before it is
   * automatically evicted by the expiration job.
   *
   * Sourced from DLQ_TTL_DAYS. Defaults to 7 when unset.
   * Must be a positive integer — zero and negative values are rejected at startup.
   */
  dlqTtlDays: number;

  /**
   * Interval between DLQ expiration sweeps, in milliseconds.
   *
   * Sourced from DLQ_EXPIRATION_INTERVAL_MS. Defaults to 3600000 (1 hour).
   * Must be a positive integer — zero and negative values are rejected at startup.
   */
  dlqExpirationIntervalMs: number;

  /**
   * Global base delay for exponential backoff, in milliseconds.
   *
   * Sourced from BACKOFF_BASE_DELAY_MS. Defaults to 1000.
   */
  backoffBaseDelayMs: number;

  /**
   * Global maximum delay cap for exponential backoff, in milliseconds.
   *
   * Sourced from BACKOFF_MAX_DELAY_MS. Defaults to 300000.
   */
  backoffMaxDelayMs: number;

  /**
   * Global exponential backoff multiplier.
   *
   * Sourced from BACKOFF_MULTIPLIER. Defaults to 2.
   */
  backoffMultiplier: number;

  /**
   * Per-job-type backoff overrides, keyed by the normalised job type
   * (e.g. "GAME_RESULT"). Job types without an entry use the global values.
   */
  backoffOverrides: Record<string, BackoffConfig>;
}

/**
 * Returns the effective exponential backoff configuration for a job type.
 * Falls back to the global backoff settings when no override is configured.
 *
 * @param jobType Job type identifier (e.g. "game-result", "GameResult").
 */
export function getBackoffConfig(jobType: string): BackoffConfig {
  const override = env.backoffOverrides[jobTypeEnvKey(jobType)];

  if (override) {
    return { ...override };
  }

  return {
    baseDelayMs: env.backoffBaseDelayMs,
    maxDelayMs: env.backoffMaxDelayMs,
    multiplier: env.backoffMultiplier,
  };
}

/** Returns the configured DLQ entry TTL in days. */
export function getDlqTtlDays(): number {
  return env.dlqTtlDays;
}

/** Returns the configured DLQ expiration sweep interval in milliseconds. */
export function getDlqExpirationIntervalMs(): number {
  return env.dlqExpirationIntervalMs;
}

/**
 * Loads and validates all environment variables required by the Oracle Service.
 * Throws on the first invalid value so the process fails fast at startup.
 */
function loadEnv(): Env {
  // Network, RPC endpoint and contract ids come from the canonical table in
  // environments.toml; conflicting overrides throw here (#118).
  const network = resolveNetworkConfig(process.env);

  const backoffBaseDelayMs = parsePositiveInt(
    'BACKOFF_BASE_DELAY_MS',
    DEFAULT_BACKOFF_BASE_DELAY_MS
  );
  const backoffMaxDelayMs = parsePositiveInt(
    'BACKOFF_MAX_DELAY_MS',
    DEFAULT_BACKOFF_MAX_DELAY_MS
  );
  const backoffMultiplier = parsePositiveNumber(
    'BACKOFF_MULTIPLIER',
    DEFAULT_BACKOFF_MULTIPLIER
  );

  return {
    stellarNetwork: network.network,
    stellarRpcUrl: network.rpcUrl,
    contractEscrow: network.contracts.escrow ?? '',
    contractOracle: network.contracts.oracle ?? '',
    lichessApiToken: process.env.LICHESS_API_TOKEN ?? '',
    chessdotcomApiKey: process.env.CHESSDOTCOM_API_KEY ?? '',
    pollingMaxRetries: parsePollingMaxRetries(),
    dlqTtlDays: parseDlqTtlDays(),
    dlqExpirationIntervalMs: parseDlqExpirationIntervalMs(),
    backoffBaseDelayMs,
    backoffMaxDelayMs,
    backoffMultiplier,
    backoffOverrides: parseBackoffOverrides({
      baseDelayMs: backoffBaseDelayMs,
      maxDelayMs: backoffMaxDelayMs,
      multiplier: backoffMultiplier,
    }),
  };
}

/**
 * Validated, typed environment configuration.
 * Evaluated once at module load time — any startup error surfaces immediately.
 */
export const env: Env = loadEnv();
