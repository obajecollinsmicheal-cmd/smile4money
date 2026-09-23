/**
 * Tests for public/_headers
 *
 * These tests verify that the Netlify/Cloudflare _headers file ships a strict
 * Content-Security-Policy and the companion security headers we rely on for
 * XSS and clickjacking protection.  The file is read from disk so the same
 * assertions cover both development and the file that gets copied into the
 * build output by Vite (Vite copies the entire `public/` directory verbatim
 * into `dist/`).
 *
 * Keeping the policy in sync:
 *   If you add a new external origin to `connect-src` (e.g. a new Stellar
 *   network endpoint), update EXPECTED_CONNECT_ORIGINS below AND update the
 *   CSP string in vite.config.ts so the dev server matches.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';

// ---------------------------------------------------------------------------
// Fixture – load the file once for all tests
// ---------------------------------------------------------------------------

/** Absolute path to the _headers file. */
const HEADERS_PATH = resolve(__dirname, '../public/_headers');

/** Full raw text of the _headers file. */
let headersContent: string;

/** The value of the Content-Security-Policy header, or empty string if absent. */
let cspValue: string;

/** Map of every header name → value found under the `/*` route rule. */
const parsedHeaders: Record<string, string> = {};

beforeAll(() => {
  headersContent = readFileSync(HEADERS_PATH, 'utf-8');

  // Parse the Netlify _headers format:
  //   /*           ← route
  //     Header: value
  //     Header: value
  let inWildcardBlock = false;
  for (const rawLine of headersContent.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === '/*') {
      inWildcardBlock = true;
      continue;
    }
    // A new route declaration (non-indented, non-comment, non-empty) ends the block
    if (inWildcardBlock && line.length > 0 && !line.startsWith('#') && !line.startsWith(' ') && !line.startsWith('\t')) {
      inWildcardBlock = false;
    }
    if (inWildcardBlock && (line.startsWith('  ') || line.startsWith('\t'))) {
      const colonIndex = line.indexOf(':');
      if (colonIndex !== -1) {
        const name = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();
        parsedHeaders[name] = value;
      }
    }
  }

  cspValue = parsedHeaders['content-security-policy'] ?? '';
});

// ---------------------------------------------------------------------------
// Helper – parse a CSP string into a directive map
// ---------------------------------------------------------------------------

function parseCSP(csp: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length === 0 || !tokens[0]) continue;
    const [directive, ...values] = tokens;
    directives[directive.toLowerCase()] = values;
  }
  return directives;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('public/_headers – file structure', () => {
  it('exists and is non-empty', () => {
    expect(headersContent.length).toBeGreaterThan(0);
  });

  it('ends with a newline (POSIX file)', () => {
    expect(headersContent.endsWith('\n')).toBe(true);
  });

  it('contains a wildcard route rule /*', () => {
    expect(headersContent).toContain('/*');
  });
});

describe('public/_headers – Content-Security-Policy presence', () => {
  it('has a Content-Security-Policy header under /*', () => {
    expect(cspValue).not.toBe('');
  });

  it('CSP value is a non-trivial string', () => {
    expect(cspValue.length).toBeGreaterThan(20);
  });
});

describe('public/_headers – CSP directive correctness', () => {
  let directives: Record<string, string[]>;

  beforeAll(() => {
    directives = parseCSP(cspValue);
  });

  // ── default-src ──────────────────────────────────────────────────────────

  it("default-src is 'self' (deny-by-default)", () => {
    expect(directives['default-src']).toEqual(["'self'"]);
  });

  // ── script-src ───────────────────────────────────────────────────────────

  it("script-src is exactly 'self' (no unsafe-inline, no unsafe-eval)", () => {
    // Stellar SDK is bundled by Vite; no external CDN scripts are needed.
    // The Freighter browser extension injects via window.freighterApi and
    // does NOT require a script-src allowance.
    expect(directives['script-src']).toEqual(["'self'"]);
  });

  it("script-src does NOT allow 'unsafe-inline'", () => {
    expect(directives['script-src'] ?? []).not.toContain("'unsafe-inline'");
  });

  it("script-src does NOT allow 'unsafe-eval'", () => {
    expect(directives['script-src'] ?? []).not.toContain("'unsafe-eval'");
  });

  // ── connect-src ──────────────────────────────────────────────────────────

  /**
   * All origins that the app is permitted to reach via fetch/XHR.
   * Update this list whenever a new external endpoint is added.
   */
  const EXPECTED_CONNECT_ORIGINS = [
    "'self'",
    'https://soroban-testnet.stellar.org',
    'https://soroban-mainnet.stellar.org',
    'https://horizon-testnet.stellar.org',
    'https://horizon.stellar.org',
  ];

  it('connect-src includes all expected Stellar RPC / Horizon origins', () => {
    const connectSrc = directives['connect-src'] ?? [];
    for (const origin of EXPECTED_CONNECT_ORIGINS) {
      expect(connectSrc).toContain(origin);
    }
  });

  it('connect-src does not allow wildcard *', () => {
    expect(directives['connect-src'] ?? []).not.toContain('*');
  });

  // ── style-src ────────────────────────────────────────────────────────────

  it("style-src includes 'self'", () => {
    // Tailwind requires unsafe-inline for runtime style injection.
    expect(directives['style-src'] ?? []).toContain("'self'");
  });

  // ── img-src ──────────────────────────────────────────────────────────────

  it("img-src includes 'self' and data:", () => {
    const imgSrc = directives['img-src'] ?? [];
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain('data:');
  });

  // ── restrictive directives ───────────────────────────────────────────────

  it("object-src is 'none' (no Flash / plugins)", () => {
    expect(directives['object-src']).toEqual(["'none'"]);
  });

  it("base-uri is 'self' (prevent <base> tag injection)", () => {
    expect(directives['base-uri']).toEqual(["'self'"]);
  });

  it("frame-ancestors is 'none' (clickjacking protection)", () => {
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
  });

  it("form-action is 'self' (prevent form hijacking)", () => {
    expect(directives['form-action']).toEqual(["'self'"]);
  });
});

describe('public/_headers – companion security headers', () => {
  it('has X-Content-Type-Options: nosniff', () => {
    expect(parsedHeaders['x-content-type-options']).toBe('nosniff');
  });

  it('has X-Frame-Options: DENY', () => {
    expect(parsedHeaders['x-frame-options']).toBe('DENY');
  });

  it('has Referrer-Policy: strict-origin-when-cross-origin', () => {
    expect(parsedHeaders['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('has a Permissions-Policy header', () => {
    expect(parsedHeaders['permissions-policy']).toBeDefined();
    expect(parsedHeaders['permissions-policy']!.length).toBeGreaterThan(0);
  });

  it('Permissions-Policy disables geolocation', () => {
    expect(parsedHeaders['permissions-policy']).toContain('geolocation=()');
  });

  it('Permissions-Policy disables camera', () => {
    expect(parsedHeaders['permissions-policy']).toContain('camera=()');
  });

  it('Permissions-Policy disables microphone', () => {
    expect(parsedHeaders['permissions-policy']).toContain('microphone=()');
  });

  it('Permissions-Policy disables payment', () => {
    expect(parsedHeaders['permissions-policy']).toContain('payment=()');
  });
});
