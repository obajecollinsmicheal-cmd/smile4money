import { describe, it, expect } from 'vitest';
import { ErrorCode, errorEnvelope, statusToErrorCode } from '../../src/errors/errorResponse.js';

describe('errorEnvelope (#50)', () => {
  it('builds the standard { error: { code, message } } shape', () => {
    expect(errorEnvelope(ErrorCode.VALIDATION_ERROR, 'bad input')).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'bad input',
        suggestion: 'Check the request fields and correct the invalid or missing values.',
        documentation:
          'https://github.com/obajecollinsmicheal-cmd/smile4money/blob/master/docs/api-reference.md#recovering-from-errors',
      },
    });
  });

  it('merges extra fields into the error object, not the top level', () => {
    const body = errorEnvelope(ErrorCode.NOT_FOUND, 'missing', { hint: 'check the id' });
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'missing',
      hint: 'check the id',
      suggestion: 'Verify the resource identifier and confirm that the resource exists.',
    });
  });

  it('accepts a plain string code for a code not in the standard set', () => {
    expect(errorEnvelope('CUSTOM_CODE', 'x').error.suggestion).toContain(
      'Review the error code and message',
    );
  });

  it('allows an error-specific recovery suggestion', () => {
    expect(
      errorEnvelope('CUSTOM_CODE', 'x', { suggestion: 'Contact the operator.' })
        .error.suggestion,
    ).toBe('Contact the operator.');
  });
});

describe('statusToErrorCode (#50)', () => {
  it('maps 400 to VALIDATION_ERROR', () => {
    expect(statusToErrorCode(400)).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('maps 401 to UNAUTHORIZED', () => {
    expect(statusToErrorCode(401)).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('maps 403 to FORBIDDEN', () => {
    expect(statusToErrorCode(403)).toBe(ErrorCode.FORBIDDEN);
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
