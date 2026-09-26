/**
 * Simple JSON logger for structured logging.
 * Outputs JSON to stdout for easy parsing and forwarding to logging services.
 */

interface LogContext {
  [key: string]: any;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private log(level: LogLevel, context: LogContext, message: string): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...context,
    };
    console.log(JSON.stringify(logEntry));
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
      this.log('error', {}, context);
    } else {
      this.log('error', context, message || '');
    }
  }
}

export default new Logger();
