import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import logger from '../src/logger.js';

/**
 * Test suite for structured JSON logging.
 *
 * Verifies that:
 * 1. Logger outputs valid JSON with all required fields
 * 2. Context fields are properly included in the output
 * 3. All log levels (info, warn, error) work correctly
 * 4. Standard fields (timestamp, level, message, service) are present
 */
describe('Structured JSON Logger', () => {
  let originalStdout: any;
  let originalStderr: any;
  let logOutput: string[] = [];

  beforeEach(() => {
    logOutput = [];

    // Capture stdout and stderr
    originalStdout = process.stdout.write;
    originalStderr = process.stderr.write;

    process.stdout.write = vi.fn((str) => {
      logOutput.push(str as string);
      return true;
    });

    process.stderr.write = vi.fn((str) => {
      logOutput.push(str as string);
      return true;
    });

    // Set to production mode for JSON output (not pretty-printing)
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    // Restore stdout/stderr
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    delete process.env.NODE_ENV;
  });

  it('logger.info emits valid JSON with context and message', () => {
    const context = { match_id: 123, player: 'alice' };
    const message = 'test_event';

    logger.info(context, message);

    // Join output and parse JSON lines
    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());

    expect(lines.length).toBeGreaterThan(0);

    // Parse first line as JSON
    const json = JSON.parse(lines[0]);

    // Verify required fields
    expect(json).toHaveProperty('timestamp');
    expect(json).toHaveProperty('level', 'info');
    expect(json).toHaveProperty('message', message);
    expect(json).toHaveProperty('service', 'smile4money-backend');

    // Verify context fields are included
    expect(json).toHaveProperty('match_id', 123);
    expect(json).toHaveProperty('player', 'alice');

    // Verify timestamp is ISO format
    const timestamp = new Date(json.timestamp);
    expect(timestamp instanceof Date && !isNaN(timestamp.getTime())).toBe(true);
  });

  it('logger.warn emits valid JSON with context and message', () => {
    const context = { dlqId: 'dlq-123', attempt: 2 };
    const message = 'retry_failed';

    logger.warn(context, message);

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());
    const json = JSON.parse(lines[0]);

    expect(json.level).toBe('warn');
    expect(json.message).toBe(message);
    expect(json.dlqId).toBe('dlq-123');
    expect(json.attempt).toBe(2);
  });

  it('logger.error emits valid JSON with context and message', () => {
    const context = { tx_hash: 'abc123', error_code: 'SUBMISSION_FAILED' };
    const message = 'oracle_submission_error';

    logger.error(context, message);

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());
    const json = JSON.parse(lines[0]);

    expect(json.level).toBe('error');
    expect(json.message).toBe(message);
    expect(json.tx_hash).toBe('abc123');
    expect(json.error_code).toBe('SUBMISSION_FAILED');
  });

  it('logger handles empty context correctly', () => {
    logger.info({}, 'empty_context_test');

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());
    const json = JSON.parse(lines[0]);

    expect(json.level).toBe('info');
    expect(json.message).toBe('empty_context_test');
    expect(json.service).toBe('smile4money-backend');
  });

  it('logger handles complex context with nested objects', () => {
    const context = {
      match_id: 456,
      result: {
        winner: 'Player1',
        score: { white: 1, black: 0 },
      },
      timestamp_ms: Date.now(),
    };
    const message = 'complex_context_test';

    logger.info(context, message);

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());
    const json = JSON.parse(lines[0]);

    expect(json.match_id).toBe(456);
    expect(json.result.winner).toBe('Player1');
    expect(json.result.score.white).toBe(1);
  });

  it('logger includes service field in all logs', () => {
    logger.info({ event: 'info_test' }, 'info_event');
    logger.warn({ event: 'warn_test' }, 'warn_event');
    logger.error({ event: 'error_test' }, 'error_event');

    const output = logOutput.join('');
    const lines = output.split('\n').filter((line) => line.trim());

    const logs = lines.map((line) => JSON.parse(line));

    logs.forEach((log) => {
      expect(log.service).toBe('smile4money-backend');
      expect(log.timestamp).toBeDefined();
    });
  });
});
