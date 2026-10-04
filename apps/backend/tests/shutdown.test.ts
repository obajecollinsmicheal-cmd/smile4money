/**
 * Integration tests for graceful shutdown (#1719).
 *
 * Uses a real http.Server (not a mock) so "stops accepting new connections"
 * and "in-flight requests complete" are genuine socket-level behaviour, not
 * an assumption about what `server.close()` does. The handler and the
 * background-worker stop functions are the injectable seams from
 * `ShutdownDeps`; this simulates the *effect* of a SIGTERM (invoking the
 * same handler `process.on('SIGTERM', ...)` would call in server.ts) rather
 * than sending a real OS signal, which would kill the test runner itself.
 */
import http from 'node:http';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createShutdownHandler, type ShutdownDeps } from '../src/shutdown.js';

function fakeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

function request(port: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

describe('createShutdownHandler (#1719)', () => {
  let server: http.Server;
  let port: number;
  let releaseSlowRequest: () => void;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/slow') {
        // Held open until the test explicitly releases it, simulating a
        // request that is actively being processed when SIGTERM arrives.
        releaseSlowRequest = () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('slow-done');
        };
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind to a TCP port');
    }
    port = address.port;
  });

  afterEach(async () => {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  function makeDeps(overrides: Partial<ShutdownDeps> = {}): {
    deps: ShutdownDeps;
    logger: ReturnType<typeof fakeLogger>;
    exit: ReturnType<typeof vi.fn>;
    stopPollingWorker: ReturnType<typeof vi.fn>;
    stopRetryWorker: ReturnType<typeof vi.fn>;
    stopDlqEviction: ReturnType<typeof vi.fn>;
    closeQueue: ReturnType<typeof vi.fn>;
    closeCircuitBreakerStore: ReturnType<typeof vi.fn>;
  } {
    const logger = fakeLogger();
    const exit = vi.fn();
    const stopPollingWorker = vi.fn().mockResolvedValue(undefined);
    const stopRetryWorker = vi.fn();
    const stopDlqEviction = vi.fn();
    const closeQueue = vi.fn().mockResolvedValue(undefined);
    const closeCircuitBreakerStore = vi.fn().mockResolvedValue(undefined);

    const deps: ShutdownDeps = {
      server,
      stopPollingWorker,
      stopRetryWorker,
      stopDlqEviction,
      closeQueue,
      closeCircuitBreakerStore,
      logger,
      shutdownTimeoutMs: 5_000,
      exit,
      ...overrides,
    };

    return { deps, logger, exit, stopPollingWorker, stopRetryWorker, stopDlqEviction, closeQueue, closeCircuitBreakerStore };
  }

  it('lets an in-flight request complete, then closes cleanly', async () => {
    const { deps, exit, stopPollingWorker, stopRetryWorker, stopDlqEviction, closeQueue, closeCircuitBreakerStore } = makeDeps();
    const shutdown = createShutdownHandler(deps);

    // Start a request that will still be in flight when shutdown begins.
    const slowRequest = request(port, '/slow');
    // Give the request a moment to actually reach the server and register
    // as an open connection before we start shutting down.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const shutdownPromise = shutdown('SIGTERM');

    // Release the in-flight request only after shutdown has begun draining —
    // proving it was allowed to finish rather than being cut off.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.listening).toBe(true); // still draining, not force-closed
    releaseSlowRequest();

    const [response] = await Promise.all([slowRequest, shutdownPromise]);

    expect(response.status).toBe(200);
    expect(response.body).toBe('slow-done');
    expect(stopPollingWorker).toHaveBeenCalledTimes(1);
    expect(stopRetryWorker).toHaveBeenCalledTimes(1);
    expect(stopDlqEviction).toHaveBeenCalledTimes(1);
    expect(closeQueue).toHaveBeenCalledTimes(1);
    expect(closeCircuitBreakerStore).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('refuses a new connection attempted after shutdown has started', async () => {
    const { deps } = makeDeps();
    const shutdown = createShutdownHandler(deps);

    const slowRequest = request(port, '/slow');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const shutdownPromise = shutdown('SIGTERM');
    // server.close() takes effect synchronously for *new* connections even
    // though its callback waits for existing ones to drain.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(request(port, '/fresh')).rejects.toBeTruthy();

    releaseSlowRequest();
    await Promise.all([slowRequest, shutdownPromise]);
  });

  it('is idempotent: a second call while shutting down is a no-op', async () => {
    const { deps, exit, stopPollingWorker } = makeDeps();
    const shutdown = createShutdownHandler(deps);

    const slowRequest = request(port, '/slow');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');

    releaseSlowRequest();
    await Promise.all([slowRequest, first, second]);

    expect(stopPollingWorker).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('force-exits with code 1 if draining exceeds shutdownTimeoutMs', async () => {
    const neverResolves = () => new Promise<void>(() => {});
    const { deps, exit } = makeDeps({
      stopPollingWorker: neverResolves,
      shutdownTimeoutMs: 30,
    });
    const shutdown = createShutdownHandler(deps);

    const slowRequest = request(port, '/slow');
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Intentionally not awaited: this shutdown() call hangs forever because
    // stopPollingWorker never resolves. The watchdog must fire regardless.
    void shutdown('SIGTERM');

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(exit).toHaveBeenCalledWith(1);

    releaseSlowRequest();
    await slowRequest.catch(() => undefined);
  });
});
