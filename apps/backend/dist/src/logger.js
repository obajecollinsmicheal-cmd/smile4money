/**
 * Simple JSON logger for structured logging.
 * Outputs JSON to stdout for easy parsing and forwarding to logging services.
 */
const DEFAULT_DEDUP_WINDOW_MS = 60 * 1000;
const SEVERITY_LEVELS = ['critical', 'error', 'warning', 'info'];
const SEVERITY_RANK = { critical: 0, error: 1, warning: 2, info: 3 };
const ALERT_SEVERITIES = new Set(['critical', 'error']);
class Logger {
    constructor() {
        this.dedupWindowMs = DEFAULT_DEDUP_WINDOW_MS;
        this.errorDedup = new Map();
        this.minSeverity = null;
        this.alertHandler = null;
    }
    static get SEVERITY_LEVELS() {
        return SEVERITY_LEVELS;
    }
    setMinSeverity(severity) {
        if (severity !== null && !SEVERITY_RANK.hasOwnProperty(severity)) {
            throw new Error(`Unknown severity: ${severity}`);
        }
        this.minSeverity = severity;
    }
    setAlertHandler(handler) {
        this.alertHandler = handler;
    }
    shouldLog(severity) {
        if (!this.minSeverity) {
            return true;
        }
        return SEVERITY_RANK[severity] <= SEVERITY_RANK[this.minSeverity];
    }
    log(level, context, message) {
        const severity = context && context.severity ? context.severity : 'info';
        if (!this.shouldLog(severity)) {
            return;
        }
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            severity,
            message,
            ...context,
        };
        console.log(JSON.stringify(logEntry));
        if (ALERT_SEVERITIES.has(severity) && typeof this.alertHandler === 'function') {
            try {
                this.alertHandler(logEntry);
            }
            catch (err) {
                console.log(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    level: 'error',
                    severity: 'error',
                    message: 'Alert handler failed',
                    error: err && err.message ? err.message : String(err),
                }));
            }
        }
    }
    debug(context, message) {
        if (typeof context === 'string') {
            this.log('debug', { severity: 'info' }, context);
        }
        else {
            this.log('debug', { severity: 'info', ...(context || {}) }, message || '');
        }
    }
    info(context, message) {
        if (typeof context === 'string') {
            this.log('info', { severity: 'info' }, context);
        }
        else {
            this.log('info', { severity: 'info', ...(context || {}) }, message || '');
        }
    }
    warn(context, message) {
        if (typeof context === 'string') {
            this.log('warn', { severity: 'warning' }, context);
        }
        else {
            this.log('warn', { severity: 'warning', ...(context || {}) }, message || '');
        }
    }
    error(context, message) {
        let ctx;
        let msg;
        if (typeof context === 'string') {
            ctx = {};
            msg = context;
        }
        else {
            ctx = context || {};
            msg = message || '';
        }
        const severity = ctx.severity && SEVERITY_RANK.hasOwnProperty(ctx.severity)
            ? ctx.severity
            : 'error';
        ctx = { ...ctx, severity };
        const key = this.getErrorKey(ctx, msg);
        const now = Date.now();
        const existing = this.errorDedup.get(key);
        if (existing && now - existing.firstSeen < this.dedupWindowMs) {
            existing.count += 1;
            return;
        }
        if (existing) {
            this.log('info', {
                severity: 'info',
                deduplicated: true,
                suppressedCount: existing.count,
                windowMs: this.dedupWindowMs,
                errorKey: key,
            }, `Suppressed ${existing.count} duplicate error(s) in the last ${this.dedupWindowMs}ms`);
        }
        this.errorDedup.set(key, { firstSeen: now, count: 0 });
        this.log('error', ctx, msg);
    }
    getErrorKey(context, message) {
        const err = context && context.error;
        const stack = err && err.stack ? err.stack : '';
        const name = err && err.name ? err.name : '';
        return `${name}|${message}|${stack}`;
    }
}
export default new Logger();
