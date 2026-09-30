import { describe, it, expect } from 'vitest';
import {
  errorToHttpStatus,
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../../src/errors/errorToHttpStatus.js';
import { RateLimitError } from '../../src/errors/RateLimitError.js';
import { GameNotFoundError as LichessFetcherGameNotFoundError } from '../../src/fetchers/lichess.js';
import { GameNotFoundError as LichessServiceGameNotFoundError } from '../../src/services/lichess.js';
import { UserNotFoundError } from '../../src/services/elo.js';

describe('errorToHttpStatus (#47)', () => {
  it('maps ValidationError to 400', () => {
    expect(errorToHttpStatus(new ValidationError('bad input'))).toBe(400);
  });

  it('maps NotFoundError to 404', () => {
    expect(errorToHttpStatus(new NotFoundError('missing'))).toBe(404);
  });

  it('maps the lichess fetcher GameNotFoundError to 404', () => {
    expect(errorToHttpStatus(new LichessFetcherGameNotFoundError('abc123'))).toBe(404);
  });

  it('maps the lichess service GameNotFoundError to 404', () => {
    expect(errorToHttpStatus(new LichessServiceGameNotFoundError('abc123'))).toBe(404);
  });

  it('maps UserNotFoundError to 404', () => {
    expect(errorToHttpStatus(new UserNotFoundError('alice'))).toBe(404);
  });

  it('maps ConflictError to 409', () => {
    expect(errorToHttpStatus(new ConflictError('duplicate'))).toBe(409);
  });

  it('maps RateLimitError to 429', () => {
    expect(errorToHttpStatus(new RateLimitError())).toBe(429);
  });

  it('maps an unrecognized Error to 500', () => {
    expect(errorToHttpStatus(new Error('boom'))).toBe(500);
  });

  it('maps a non-Error thrown value to 500', () => {
    expect(errorToHttpStatus('some string error')).toBe(500);
    expect(errorToHttpStatus(undefined)).toBe(500);
    expect(errorToHttpStatus(null)).toBe(500);
  });
});
