import { describe, it, expect } from 'vitest';
import {
  validateAndConvertXlmToStroops,
  countDecimalPlaces,
  roundXlmToPrecision,
} from '../src/utils/xlm-precision';

describe('XLM Precision Validation — countDecimalPlaces', () => {
  it('returns 0 for whole numbers', () => {
    expect(countDecimalPlaces('1')).toBe(0);
    expect(countDecimalPlaces('100')).toBe(0);
    expect(countDecimalPlaces('0')).toBe(0);
    expect(countDecimalPlaces('1000000')).toBe(0);
  });

  it('counts decimal places correctly', () => {
    expect(countDecimalPlaces('1.5')).toBe(1);
    expect(countDecimalPlaces('1.23')).toBe(2);
    expect(countDecimalPlaces('0.1234567')).toBe(7);
    expect(countDecimalPlaces('0.12345678')).toBe(8);
  });

  it('handles leading zeros in decimal part', () => {
    expect(countDecimalPlaces('1.01')).toBe(2);
    expect(countDecimalPlaces('1.001')).toBe(3);
    expect(countDecimalPlaces('0.0000001')).toBe(7);
  });

  it('trims whitespace before counting', () => {
    expect(countDecimalPlaces('  1.5  ')).toBe(1);
    expect(countDecimalPlaces(' 100 ')).toBe(0);
  });

  it('handles numbers starting with decimal point', () => {
    expect(countDecimalPlaces('.5')).toBe(1);
    expect(countDecimalPlaces('.123456')).toBe(6);
  });
});

describe('XLM Precision Validation — validateAndConvertXlmToStroops', () => {
  describe('valid inputs', () => {
    it('converts whole XLM values to stroops', () => {
      const result = validateAndConvertXlmToStroops('1');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(10_000_000n);
      expect(result.decimals).toBe(0);
    });

    it('converts decimal XLM values to stroops', () => {
      const result = validateAndConvertXlmToStroops('1.5');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(15_000_000n);
      expect(result.decimals).toBe(1);
    });

    it('handles maximum precision (7 decimal places)', () => {
      const result = validateAndConvertXlmToStroops('1.1234567');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(11_234_567n);
      expect(result.decimals).toBe(7);
      expect(result.message).toBeUndefined();
    });

    it('converts boundary value 0.0000001 (1 stroop)', () => {
      const result = validateAndConvertXlmToStroops('0.0000001');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(1n);
      expect(result.decimals).toBe(7);
    });

    it('converts large XLM amounts', () => {
      const result = validateAndConvertXlmToStroops('1000000');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(10_000_000_000_000n);
    });

    it('handles zero', () => {
      const result = validateAndConvertXlmToStroops('0');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(0n);
    });

    it('trims whitespace', () => {
      const result = validateAndConvertXlmToStroops('  1.5  ');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(15_000_000n);
    });

    it('handles numbers starting with decimal point', () => {
      const result = validateAndConvertXlmToStroops('.5');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(5_000_000n);
    });

    it('handles numbers with trailing zeros in decimal part', () => {
      const result = validateAndConvertXlmToStroops('1.50');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(15_000_000n);
    });
  });

  describe('over-precision inputs (>7 decimal places)', () => {
    it('rejects 8 decimal places', () => {
      const result = validateAndConvertXlmToStroops('1.12345678');
      expect(result.valid).toBe(false);
      expect(result.decimals).toBe(8);
      expect(result.message).toContain('exceeds 7 decimal places');
      expect(result.stroops).toBeUndefined();
    });

    it('rejects 9 decimal places', () => {
      const result = validateAndConvertXlmToStroops('0.123456789');
      expect(result.valid).toBe(false);
      expect(result.decimals).toBe(9);
      expect(result.message).toContain('exceeds 7 decimal places');
    });

    it('rejects 15 decimal places', () => {
      const result = validateAndConvertXlmToStroops('0.123456789012345');
      expect(result.valid).toBe(false);
      expect(result.decimals).toBe(15);
      expect(result.message).toContain('exceeds 7 decimal places');
    });
  });

  describe('boundary cases', () => {
    it('accepts exactly 7 decimal places', () => {
      const result = validateAndConvertXlmToStroops('0.1234567');
      expect(result.valid).toBe(true);
      expect(result.decimals).toBe(7);
    });

    it('rejects 8 decimal places even with very small value', () => {
      const result = validateAndConvertXlmToStroops('0.00000001');
      expect(result.valid).toBe(false);
      expect(result.decimals).toBe(8);
    });

    it('converts smallest valid unit (1 stroop = 0.0000001 XLM)', () => {
      const result = validateAndConvertXlmToStroops('0.0000001');
      expect(result.valid).toBe(true);
      expect(result.stroops).toBe(1n);
    });
  });

  describe('invalid inputs', () => {
    it('rejects empty string', () => {
      const result = validateAndConvertXlmToStroops('');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('required');
    });

    it('rejects whitespace-only string', () => {
      const result = validateAndConvertXlmToStroops('   ');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('required');
    });

    it('rejects non-numeric strings', () => {
      const result = validateAndConvertXlmToStroops('abc');
      expect(result.valid).toBe(false);
      expect(result.message).toContain('valid number');
    });

    it('rejects strings with letters', () => {
      const result = validateAndConvertXlmToStroops('1.5abc');
      expect(result.valid).toBe(false);
    });

    it('rejects negative numbers', () => {
      const result = validateAndConvertXlmToStroops('-1.5');
      expect(result.valid).toBe(false);
    });

    it('rejects multiple decimal points', () => {
      const result = validateAndConvertXlmToStroops('1.5.5');
      expect(result.valid).toBe(false);
    });

    it('rejects scientific notation', () => {
      const result = validateAndConvertXlmToStroops('1e5');
      expect(result.valid).toBe(false);
    });

    it('rejects special characters', () => {
      const result = validateAndConvertXlmToStroops('$1.50');
      expect(result.valid).toBe(false);
    });

    it('rejects comma separators', () => {
      const result = validateAndConvertXlmToStroops('1,000');
      expect(result.valid).toBe(false);
    });
  });

  describe('conversion accuracy', () => {
    it('accurately converts 0.5 XLM to 5,000,000 stroops', () => {
      const result = validateAndConvertXlmToStroops('0.5');
      expect(result.stroops).toBe(5_000_000n);
    });

    it('accurately converts 2.1234567 XLM to 21,234,567 stroops', () => {
      const result = validateAndConvertXlmToStroops('2.1234567');
      expect(result.stroops).toBe(21_234_567n);
    });

    it('accurately converts 0.0000001 XLM to 1 stroop', () => {
      const result = validateAndConvertXlmToStroops('0.0000001');
      expect(result.stroops).toBe(1n);
    });

    it('accurately converts 100 XLM to 1,000,000,000 stroops', () => {
      const result = validateAndConvertXlmToStroops('100');
      expect(result.stroops).toBe(1_000_000_000n);
    });
  });
});

describe('XLM Precision Validation — roundXlmToPrecision', () => {
  it('returns unchanged value if within 7 decimal places', () => {
    expect(roundXlmToPrecision('1.5')).toBe('1.5');
    expect(roundXlmToPrecision('1.123456')).toBe('1.123456');
    expect(roundXlmToPrecision('1.1234567')).toBe('1.1234567');
  });

  it('truncates excess decimal places', () => {
    expect(roundXlmToPrecision('1.12345678')).toBe('1.1234567');
    expect(roundXlmToPrecision('1.123456789')).toBe('1.1234567');
  });

  it('truncates many excess decimal places', () => {
    expect(roundXlmToPrecision('0.123456789123456')).toBe('0.1234567');
  });

  it('preserves whole numbers', () => {
    expect(roundXlmToPrecision('100')).toBe('100');
    expect(roundXlmToPrecision('0')).toBe('0');
  });

  it('trims whitespace', () => {
    expect(roundXlmToPrecision('  1.12345678  ')).toBe('1.1234567');
  });

  it('handles numbers starting with decimal point', () => {
    expect(roundXlmToPrecision('.12345678')).toBe('.1234567');
  });

  it('truncates to exactly 7 places', () => {
    const result = roundXlmToPrecision('1.999999999');
    expect(result).toBe('1.9999999');
    expect(countDecimalPlaces(result)).toBe(7);
  });
});

describe('XLM Precision Validation — integration scenarios', () => {
  it('handles user input flow: type value → validate → convert', () => {
    // User enters "1.5" XLM
    const validation = validateAndConvertXlmToStroops('1.5');
    expect(validation.valid).toBe(true);
    expect(validation.stroops).toBe(15_000_000n);

    // Component sends stroops to contract
    const stakeAmount = validation.stroops?.toString();
    expect(stakeAmount).toBe('15000000');
  });

  it('handles over-precision input with rounding', () => {
    // User enters "1.123456789" XLM (9 decimals)
    const rounded = roundXlmToPrecision('1.123456789');
    expect(rounded).toBe('1.1234567'); // Truncated to 7 decimals

    // Validate rounded value
    const validation = validateAndConvertXlmToStroops(rounded);
    expect(validation.valid).toBe(true);
    expect(validation.stroops).toBe(11_234_567n);
  });

  it('rejects input if precision exceeds limit even after rounding attempt', () => {
    // User enters "0.00000001" (8 decimals, too precise)
    const validation = validateAndConvertXlmToStroops('0.00000001');
    expect(validation.valid).toBe(false);

    // Try rounding (this is what happens in the component)
    const rounded = roundXlmToPrecision('0.00000001');
    expect(rounded).toBe('0.0000000'); // Still invalid precision message shown in UI
  });

  it('minimum stake validation', () => {
    // Minimum is 1 stroop = 0.0000001 XLM
    const result = validateAndConvertXlmToStroops('0.0000001');
    expect(result.valid).toBe(true);
    expect(result.stroops).toBe(1n);
  });

  it('large stake validation', () => {
    // Maximum is 10 trillion stroops = 1 million XLM
    const result = validateAndConvertXlmToStroops('1000000');
    expect(result.valid).toBe(true);
    expect(result.stroops).toBe(10_000_000_000_000n);
  });
});
