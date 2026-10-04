import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { createStellarRpcClient } from "../src/services/stellar.js";

describe("Soroban RPC HTTP connection pooling", () => {
  let server: http.Server;
  let rpcUrl: string;
  let connectionCount = 0;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { status: "healthy" },
          }),
        );
      });
    });
    server.on("connection", () => {
      connectionCount += 1;
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test RPC server did not bind to a TCP port");
    }
    rpcUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("reduces TCP connections for repeated RPC calls when pooling is enabled", async () => {
    const pooledClient = createStellarRpcClient({
      poolSize: 4,
      keepAliveTimeoutMs: 1_000,
    });
    const nonPooledClient = axios.create({
      httpAgent: new http.Agent({ keepAlive: false }),
    });

    connectionCount = 0;
    for (let requestNumber = 0; requestNumber < 20; requestNumber += 1) {
      await pooledClient.post(rpcUrl, {
        method: "get health",
        params: [],
        id: requestNumber,
        jsonrpc: "2.0",
      });
    }
    const pooledConnections = connectionCount;

    for (let requestNumber = 0; requestNumber < 20; requestNumber += 1) {
      await nonPooledClient.post(rpcUrl, {
        method: "get health",
        params: [],
        id: requestNumber,
        jsonrpc: "2.0",
      });
    }
    const nonPooledConnections = connectionCount - pooledConnections;

    expect(pooledConnections).toBe(1);
    expect(nonPooledConnections).toBe(20);
  });
});

// #1718 — a hanging RPC node must produce a typed RpcTimeoutError, not a
// generic axios rejection, and the timeout must be configurable via env var.
describe("Soroban RPC request timeout (#1718)", () => {
  let server: http.Server;
  let rpcUrl: string;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        // Deliberately never respond within the test's configured timeout,
        // simulating a hanging Soroban RPC node.
        setTimeout(() => {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sequence: 1 } }),
          );
        }, 500);
      });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test RPC server did not bind to a TCP port");
    }
    rpcUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("checkStellarRpc rejects with a typed RpcTimeoutError when the RPC node hangs past STELLAR_RPC_HEALTH_TIMEOUT_MS", async () => {
    process.env.STELLAR_RPC_URL = rpcUrl;
    process.env.STELLAR_RPC_HEALTH_TIMEOUT_MS = "50";

    // Import both from the same freshly-reset module registry as
    // stellar.js's own import of RpcTimeoutError.js, so `instanceof` checks
    // the same class object rather than two identically-shaped classes from
    // two different module instances (a `vi.resetModules()` pitfall).
    const { checkStellarRpc } = await import("../src/services/stellar.js");
    const { RpcTimeoutError } = await import("../src/errors/RpcTimeoutError.js");

    await expect(checkStellarRpc()).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("getCurrentLedger rejects with a typed RpcTimeoutError when the RPC node hangs past STELLAR_RPC_TIMEOUT_MS", async () => {
    process.env.STELLAR_RPC_URL = rpcUrl;
    process.env.STELLAR_RPC_TIMEOUT_MS = "50";

    const { getCurrentLedger } = await import("../src/services/stellar.js");
    const { RpcTimeoutError } = await import("../src/errors/RpcTimeoutError.js");

    await expect(getCurrentLedger()).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("does not time out when the response arrives within the configured budget", async () => {
    process.env.STELLAR_RPC_URL = rpcUrl;
    process.env.STELLAR_RPC_HEALTH_TIMEOUT_MS = "5000";

    const { checkStellarRpc } = await import("../src/services/stellar.js");

    await expect(checkStellarRpc()).resolves.toBeUndefined();
  });
});
