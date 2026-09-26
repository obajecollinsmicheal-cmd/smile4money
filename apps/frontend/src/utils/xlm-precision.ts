/**
 * XLM to Stroops conversion and precision validation utilities.
 *
 * 1 XLM = 10,000,000 stroops (10^7)
 * Maximum decimal precision: 7 places (matching stroop precision)
 *
 * Examples:
 * - 1.5 XLM = 15,000,000 stroops ✓ (1 decimal place)
 * - 1.1234567 XLM = 11,234,567 stroops ✓ (7 decimal places)
 * - 1.12345678 XLM = invalid ✗ (8 decimal places, exceeds precision)
 */

const STROOPS_PER_XLM = 10_000_000n;
const MAX_DECIMAL_PLACES = 7;

export interface PrecisionValidationResult {
  valid: boolean;
  stroops?: bigint;
  decimals?: number;
  message?: string;
}

/**
 * Count the number of decimal places in a numeric string.
 * E.g., "1.23" → 2, "1" → 0, "0.1" → 1
 */
export function countDecimalPlaces(value: string): number {
  const trimmed = value.trim();
  const dotIndex = trimmed.indexOf('.');
  if (dotIndex === -1) {
    return 0;
  }
  return trimmed.length - dotIndex - 1;
}

/**
 * Parse a decimal XLM string and convert to stroops (BigInt).
 *
 * Validates that the input has at most 7 decimal places (matching stroop precision).
 * Returns a validation result object with status and optional stroops amount.
 *
 * @param xlmValue - The decimal XLM string to convert (e.g., "1.5", "10", "0.1234567")
 * @returns Validation result with stroops amount if valid, error message if invalid
 *
 * @example
 * validateAndConvertXlmToStroops("1.5")
 * // → { valid: true, stroops: 15000000n, decimals: 1 }
 *
 * validateAndConvertXlmToStroops("1.12345678")
 * // → { valid: false, decimals: 8, message: "XLM precision exceeds 7 decimal places" }
 */
export function validateAndConvertXlmToStroops(xlmValue: string): PrecisionValidationResult {
  const trimmed = xlmValue.trim();

  // Empty check
  if (!trimmed) {
    return { valid: false, message: 'Value is required' };
  }

  // Non-numeric check
  if (!/^(\d+\.?\d*|\.\d+)$/.test(trimmed)) {
    return { valid: false, message: 'Value must be a valid number' };
  }

  // Count decimal places
  const decimals = countDecimalPlaces(trimmed);

  // Precision check: max 7 decimal places
  if (decimals > MAX_DECIMAL_PLACES) {
    return {
      valid: false,
      decimals,
      message: `XLM precision exceeds ${MAX_DECIMAL_PLACES} decimal places (found ${decimals})`,
    };
  }

  // Convert to BigInt stroops
  // Strategy: pad the fractional part to 7 digits, then parse as integer
  // E.g., "1.5" → "1.5000000" → 15000000
  let stroopsStr: string;
  if (trimmed.includes('.')) {
    const [whole, frac] = trimmed.split('.');
    const paddedFrac = frac.padEnd(MAX_DECIMAL_PLACES, '0');
    stroopsStr = whole + paddedFrac;
  } else {
    // No decimal point, pad with zeros
    stroopsStr = trimmed + '0'.repeat(MAX_DECIMAL_PLACES);
  }

  // Parse and ensure valid BigInt
  let stroops: bigint;
  try {
    stroops = BigInt(stroopsStr);
  } catch {
    return { valid: false, message: 'Invalid XLM amount' };
  }

  return {
    valid: true,
    stroops,
    decimals,
  };
}

/**
 * Round a decimal XLM value to a maximum of 7 decimal places.
 * Excess precision is truncated (not rounded up).
 *
 * @param xlmValue - The decimal XLM string
 * @returns Rounded XLM value as string, or original if already within precision
 *
 * @example
 * roundXlmToPrecision("1.123456789")
 * // → "1.1234567"
 */
export function roundXlmToPrecision(xlmValue: string): string {
  const trimmed = xlmValue.trim();
  const decimals = countDecimalPlaces(trimmed);

  if (decimals <= MAX_DECIMAL_PLACES) {
    return trimmed;
  }

  if (!trimmed.includes('.')) {
    return trimmed;
  }

  const [whole, frac] = trimmed.split('.');
  const truncatedFrac = frac.substring(0, MAX_DECIMAL_PLACES);
  return `${whole}.${truncatedFrac}`;
}
