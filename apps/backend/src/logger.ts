import { LOG_EVENTS } from './log-events.js';

const NUMERIC_FIELDS = new Set([
  'status',
  'duration_ms',
  'count',
  'store_count',
  'attempt',
  'attempts',
  'max_retries',
  'retry_delay_ms',
  'nextRetryDelayMs',
  'totalAttempts',
  'port',
  'value',
  'remaining',
  'cooldown',
  'failureCount',
  'durationMs',
  'suppressed_count',
]);
const ENUM_FIELDS: Record<string, readonly string[]> = {
  method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  platform: ['lichess', 'chessdotcom'],
  state: ['CLOSED', 'OPEN', 'HALF_OPEN'],
  store: ['sqlite', 'memory', 'mongodb'],
  sqlite_error_code: ['SQLITE_BUSY', 'SQLITE_LOCKED'],
  metric: ['oracle_dlq_depth'],
  severity: ['critical', 'error', 'warning', 'info'],
};

/** Unknown fields and all arbitrary strings/errors are masked at the sink. */
export function safeLogContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(context)
      .filter(
        ([key]) =>
          NUMERIC_FIELDS.has(key) ||
          Object.prototype.hasOwnProperty.call(ENUM_FIELDS, key),
      )
      .map(([key, value]) => [
        key,
        NUMERIC_FIELDS.has(key) &&
        typeof value === 'number' &&
        Number.isFinite(value)
          ? value
          : typeof value === 'string' && ENUM_FIELDS[key]?.includes(value)
            ? value
            : '[REDACTED]',
      ]),
  );
}

/**
 * Simple JSON logger for structured logging.
 * Outputs JSON to stdout for easy parsing and forwarding to logging services.
 */

interface LogContext {
  [key: string]: any;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Error severity classification, ordered from most to least severe.
 * Used to categorize errors for filtering and severity-based alerting.
 */
export type Severity = 'critical' | 'error' | 'warning' | 'info';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
};

/** Severities at or above this threshold raise an alert. */
const ALERT_SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'error']);

function configuredMinSeverity(): Severity {
  const raw = (process.env.LOG_MIN_SEVERITY || '').toLowerCase();
  if (raw === 'critical' || raw === 'error' || raw === 'warning' || raw === 'info') {
    return raw;
  }
  return 'info';
}

function configuredLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

/** Default suppression window for duplicate errors (1 minute). */
const DEFAULT_DEDUP_WINDOW_MS = 60_000;

function configuredDedupWindowMs(): number {
  const raw = Number(process.env.LOG_DEDUP_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEDUP_WINDOW_MS;
}

interface DedupEntry {
  firstSeen: number;
  suppressed: number;
}

class Logger {
  private dedupEntries = new Map<string, DedupEntry>();

  /** Exposed so callers can skip building an expensive log payload entirely when it won't be emitted. */
  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[configuredLevel()];
  }

  /** Returns true when an error of the given severity passes the configured severity filter. */
  isSeverityEnabled(severity: Severity): boolean {
    return SEVERITY_ORDER[severity] <= SEVERITY_ORDER[configuredMinSeverity()];
  }

  private log(level: LogLevel, context: LogContext, message: string): void {
    if (!this.isLevelEnabled(level)) {
      return;
    }
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: 'smile4money-backend',
      message: LOG_EVENTS.has(message) ? message : 'log_event',
      ...safeLogContext(context),
    };
    console.log(JSON.stringify(logEntry));
  }

  /**
   * Emits an alert for errors whose severity warrants operator attention.
   * Alerts are logged as a distinct event so downstream alerting can key on it.
   */
  private maybeAlert(severity: Severity, context: LogContext, message: string): void {
    if (!ALERT_SEVERITIES.has(severity)) {
      return;
    }
    this.log('error', { ...context, severity }, 'error_alert');
  }

  /**
   * Builds a stable identity for an error so identical errors can be deduplicated.
   * Uses the message plus the first stack frame (when available) to distinguish
   * errors that share a message but originate from different call sites.
   */
  private errorIdentity(context: LogContext, message: string): string {
    const err = context?.error ?? context?.err;
    const errMessage =
      typeof err === 'string'
        ? err
        : err && typeof err.message === 'string'
          ? err.message
          : '';
    const stack =
      err && typeof err.stack === 'string' ? err.stack.split('\n')[1]?.trim() : '';
    return `${message}|${errMessage}|${stack ?? ''}`;
  }

  /**
   * Returns true when the error should be suppressed as a duplicate within the
   * configured window. When a window expires, the accumulated suppressed count
   * is logged so operators can see how many duplicates were dropped.
   */
  private shouldSuppressError(identity: string): boolean {
    const now = Date.now();
    const windowMs = configuredDedupWindowMs();
    const entry = this.dedupEntries.get(identity);

    if (!entry) {
      this.dedupEntries.set(identity, { firstSeen: now, suppressed: 0 });
      return false;
    }

    if (now - entry.firstSeen < windowMs) {
      entry.suppressed += 1;
      return true;
    }

    // Window expired: report how many duplicates were suppressed, then reset.
    if (entry.suppressed > 0) {
      this.log('info', { suppressed_count: entry.suppressed }, 'error_deduplicated');
    }
    this.dedupEntries.set(identity, { firstSeen: now, suppressed: 0 });
    return false;
  }

  debug(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('debug', {}, context);
    } else {
      this.log('debug', context, message || '');
    }
  }

  info(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('info', {}, context);
    } else {
      this.log('info', context, message || '');
    }
  }

  warn(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.log('warn', {}, context);
    } else {
      this.log('warn', context, message || '');
    }
  }

  error(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      if (this.shouldSuppressError(this.errorIdentity({}, context))) {
        return;
      }
      this.log('error', {}, context);
    } else {
      const msg = message || '';
      if (this.shouldSuppressError(this.errorIdentity(context, msg))) {
        return;
      }
      this.log('error', context, msg);
    }
  }

  /**
   * Logs an error with an explicit severity classification. The severity is
   * attached to the entry for filtering, and severities at or above the alert
   * threshold additionally raise an alert.
   */
  classifiedError(
    severity: Severity,
    context: LogContext | string,
    message?: string,
  ): void {
    if (!this.isSeverityEnabled(severity)) {
      return;
    }
    const ctx: LogContext = typeof context === 'string' ? {} : context;
    const msg = typeof context === 'string' ? context : message || '';
    if (this.shouldSuppressError(this.errorIdentity(ctx, msg))) {
      return;
    }
    this.log('error', { ...ctx, severity }, msg);
    this.maybeAlert(severity, ctx, msg);
  }
}

export default new Logger();
