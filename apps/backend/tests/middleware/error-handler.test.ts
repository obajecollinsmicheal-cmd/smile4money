import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { apiErrorHandler } from "../../src/middleware/error-handler.js";
import { ValidationError } from "../../src/errors/errorToHttpStatus.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("logs unhandled server errors with structured stack metadata and returns safe recovery guidance", async () => {
  vi.stubEnv("LOG_LEVEL", "debug");
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) =>
    lines.push(String(value)),
  );
  const app = express();
  app.get("/failure", () => {
    throw new Error("Bearer token-secret email-secret@example.com");
  });
  app.use(apiErrorHandler);

  const response = await request(app).get("/failure").expect(500);

  expect(response.body.error).toMatchObject({
    code: "INTERNAL_ERROR",
    message: "An unexpected server error occurred.",
    suggestion: expect.stringContaining("Retry once"),
    documentation: expect.stringContaining(
      "api-reference.md#recovering-from-errors",
    ),
  });
  expect(response.body.error.message).not.toContain("token-secret");
  const log = JSON.parse(lines[0]);
  expect(log).toMatchObject({
    level: "error",
    severity: "error",
    message: "http_request_failed",
    status: 500,
    method: "GET",
    error: { type: "Error" },
  });
  expect(log.error.stack.length).toBeGreaterThan(0);
  expect(lines.join("")).not.toMatch(/token-secret|email-secret@example\.com/);
});

it("returns actionable guidance and warning severity for client errors", async () => {
  vi.stubEnv("LOG_LEVEL", "debug");
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) =>
    lines.push(String(value)),
  );
  const app = express();
  app.get("/invalid", (_req, _res, next) => {
    next(new ValidationError("invalid field"));
  });
  app.use(apiErrorHandler);

  const response = await request(app).get("/invalid").expect(400);

  expect(response.body.error).toMatchObject({
    code: "VALIDATION_ERROR",
    message: "invalid field",
    suggestion: expect.stringContaining(
      "correct the invalid or missing values",
    ),
  });
  expect(JSON.parse(lines[0])).toMatchObject({
    level: "warn",
    severity: "warning",
    status: 400,
  });
});
