import { describe, it, expect } from 'vitest';
import { ErrorCode, errorEnvelope, statusToErrorCode } from '../../src/errors/errorResponse.js';

describe('errorEnvelope (#50)', () => {
  it('builds the standard { error: { code, message } } shape', () => {
    expect(errorEnvelope(ErrorCode.VALIDATION_ERROR, 'bad input')).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'bad input' },
    });
  });

  it('merges extra fields into the error object, not the top level', () => {
    const body = errorEnvelope(ErrorCode.NOT_FOUND, 'missing', { hint: 'check the id' });
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toEqual({ code: 'NOT_FOUND', message: 'missing', hint: 'check the id' });
  });

  it('accepts a plain string code for a code not in the standard set', () => {
    expect(errorEnvelope('CUSTOM_CODE', 'x')).toEqual({ error: { code: 'CUSTOM_CODE', message: 'x' } });
  });
});

describe('statusToErrorCode (#50)', () => {
  it('maps 400 to VALIDATION_ERROR', () => {
    expect(statusToErrorCode(400)).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('maps 401 to UNAUTHORIZED', () => {
    expect(statusToErrorCode(401)).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('maps 404 to NOT_FOUND', () => {
    expect(statusToErrorCode(404)).toBe(ErrorCode.NOT_FOUND);
  });

  it('maps 409 to CONFLICT', () => {
    expect(statusToErrorCode(409)).toBe(ErrorCode.CONFLICT);
  });

  it('maps 429 to RATE_LIMITED', () => {
    expect(statusToErrorCode(429)).toBe(ErrorCode.RATE_LIMITED);
  });

  it('maps any other status to INTERNAL_ERROR', () => {
    expect(statusToErrorCode(500)).toBe(ErrorCode.INTERNAL_ERROR);
    expect(statusToErrorCode(502)).toBe(ErrorCode.INTERNAL_ERROR);
    expect(statusToErrorCode(999)).toBe(ErrorCode.INTERNAL_ERROR);
  });
});
