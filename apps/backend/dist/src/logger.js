/**
 * Simple JSON logger for structured logging.
 * Outputs JSON to stdout for easy parsing and forwarding to logging services.
 */
class Logger {
    log(level, context, message) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            ...context,
        };
        console.log(JSON.stringify(logEntry));
    }
    debug(context, message) {
        if (typeof context === 'string') {
            this.log('debug', {}, context);
        }
        else {
            this.log('debug', context, message || '');
        }
    }
    info(context, message) {
        if (typeof context === 'string') {
            this.log('info', {}, context);
        }
        else {
            this.log('info', context, message || '');
        }
    }
    warn(context, message) {
        if (typeof context === 'string') {
            this.log('warn', {}, context);
        }
        else {
            this.log('warn', context, message || '');
        }
    }
    error(context, message) {
        if (typeof context === 'string') {
            this.log('error', {}, context);
        }
        else {
            this.log('error', context, message || '');
        }
    }
}
export default new Logger();
