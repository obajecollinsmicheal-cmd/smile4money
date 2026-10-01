/**
 * Tests for the request-logging middleware (#1722):
 * - Request bodies must never appear in INFO-level output.
 * - At DEBUG level, sensitive fields are redacted before the body is logged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestLogging, redactSensitiveFields } from '../../src/middleware/request-logging.js';

function captureConsoleLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
    lines.push(String(arg));
  });
  return lines;
}

function parsedLogs(lines: string[]): any[] {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appWithLogging() {
  const app = express();
  app.use(express.json());
  app.use(requestLogging());
  app.post('/echo', (req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('redactSensitiveFields', () => {
  it('replaces known-sensitive keys with a redaction marker', () => {
    const result = redactSensitiveFields({
      player1: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player2: 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      username: 'alice',
      gameId: 'game-123',
      stakeAmount: 100,
    }) as Record<string, unknown>;

    expect(result.player1).toBe('[REDACTED]');
    expect(result.player2).toBe('[REDACTED]');
    expect(result.username).toBe('[REDACTED]');
    // Non-sensitive fields pass through unchanged.
    expect(result.gameId).toBe('game-123');
    expect(result.stakeAmount).toBe(100);
  });

  it('is case-insensitive on key names', () => {
    const result = redactSensitiveFields({ Player1: 'GABC', WalletAddress: 'GXYZ' }) as Record<string, unknown>;
    expect(result.Player1).toBe('[REDACTED]');
    expect(result.WalletAddress).toBe('[REDACTED]');
  });

  it('passes through non-object bodies unchanged', () => {
    expect(redactSensitiveFields(null)).toBeNull();
    expect(redactSensitiveFields(undefined)).toBeUndefined();
    expect(redactSensitiveFields('a string')).toBe('a string');
  });
});

describe('requestLogging middleware', () => {
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('at INFO level (production default), no sensitive fields or body appear anywhere in the output', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_LEVEL;
    const lines = captureConsoleLog();

    await request(appWithLogging())
      .post('/echo')
      .send({ player1: 'GSECRETADDRESS', username: 'alice', gameId: 'game-123' });

    const logs = parsedLogs(lines);
    expect(logs.length).toBeGreaterThan(0);

    for (const entry of logs) {
      expect(entry.body).toBeUndefined();
      expect(JSON.stringify(entry)).not.toContain('GSECRETADDRESS');
      expect(JSON.stringify(entry)).not.toContain('alice');
    }

    // The INFO request-summary line must still be present.
    const summary = logs.find((l) => l.message === 'http_request');
    expect(summary).toBeDefined();
    expect(summary.method).toBe('POST');
    expect(summary.status).toBe(200);
  });

  it('at DEBUG level, the body is logged but sensitive fields are redacted, not raw', async () => {
    process.env.LOG_LEVEL = 'debug';
    const lines = captureConsoleLog();

    await request(appWithLogging())
      .post('/echo')
      .send({ player1: 'GSECRETADDRESS', username: 'alice', gameId: 'game-123' });

    const logs = parsedLogs(lines);
    const bodyLog = logs.find((l) => l.message === 'http_request_body');
    expect(bodyLog).toBeDefined();
    expect(bodyLog.body.player1).toBe('[REDACTED]');
    expect(bodyLog.body.username).toBe('[REDACTED]');
    expect(bodyLog.body.gameId).toBe('game-123'); // non-sensitive, passes through

    // The raw secret value must never appear anywhere in the emitted output.
    expect(JSON.stringify(logs)).not.toContain('GSECRETADDRESS');
  });

  it('does not emit a body line at all when DEBUG is not enabled', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_LEVEL;
    const lines = captureConsoleLog();

    await request(appWithLogging()).post('/echo').send({ player1: 'GSECRETADDRESS' });

    const logs = parsedLogs(lines);
    expect(logs.find((l) => l.message === 'http_request_body')).toBeUndefined();
  });
});
