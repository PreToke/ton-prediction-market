/**
 * Unit tests for the Fixed-Point Math Library (Q64.64 format).
 *
 * Tests the TypeScript reference implementation of fixed_mul, fixed_div,
 * fixed_log2, fixed_pow2, fixed_exp, and fixed_ln with known values and edge cases.
 *
 * Q64.64 format: ONE = 2^64 represents 1.0
 */

import { describe, it, expect } from 'vitest';
import {
  ONE,
  LOG2_E,
  LN_2,
  fixedMul,
  fixedDiv,
  fixedLog2,
  fixedPow2,
  fixedExp,
  fixedLn,
  toFixed,
  fromFixed,
} from '../../wrappers-ts/FixedMath.gen';

/**
 * Tolerance for transcendental function comparisons.
 * ±2^44 gives approximately 0.001% relative error for values near ONE.
 */
const TOLERANCE = 1n << 44n;

/** Helper: assert two Q64.64 values are within tolerance */
function expectClose(actual: bigint, expected: bigint, tol: bigint = TOLERANCE) {
  const diff = actual > expected ? actual - expected : expected - actual;
  expect(diff).toBeLessThanOrEqual(tol);
}

describe('Fixed-Point Math Library', () => {
  describe('fixedMul (a * b) >> 64', () => {
    it('1.0 * 1.0 = 1.0', () => {
      expect(fixedMul(ONE, ONE)).toBe(ONE);
    });

    it('2.0 * 3.0 = 6.0', () => {
      const two = ONE * 2n;
      const three = ONE * 3n;
      const six = ONE * 6n;
      expect(fixedMul(two, three)).toBe(six);
    });

    it('0.5 * 0.5 = 0.25', () => {
      const half = ONE / 2n;
      const quarter = ONE / 4n;
      expect(fixedMul(half, half)).toBe(quarter);
    });

    it('0 * anything = 0', () => {
      expect(fixedMul(0n, ONE)).toBe(0n);
      expect(fixedMul(0n, ONE * 1000n)).toBe(0n);
      expect(fixedMul(ONE * 42n, 0n)).toBe(0n);
    });

    it('1.0 * x = x (identity)', () => {
      const x = ONE * 7n + ONE / 3n; // 7.333...
      expect(fixedMul(ONE, x)).toBe(x);
      expect(fixedMul(x, ONE)).toBe(x);
    });

    it('handles large values without overflow in bigint', () => {
      const hundred = ONE * 100n;
      const thousand = ONE * 1000n;
      expect(fixedMul(hundred, thousand)).toBe(ONE * 100000n);
    });
  });

  describe('fixedDiv (a << 64) / b', () => {
    it('1.0 / 1.0 = 1.0', () => {
      expect(fixedDiv(ONE, ONE)).toBe(ONE);
    });

    it('6.0 / 2.0 = 3.0', () => {
      const six = ONE * 6n;
      const two = ONE * 2n;
      const three = ONE * 3n;
      expect(fixedDiv(six, two)).toBe(three);
    });

    it('1.0 / 3.0 ≈ 0.333...', () => {
      const result = fixedDiv(ONE, ONE * 3n);
      const expected = ONE / 3n; // integer division of ONE by 3
      // (ONE << 64) / (3*ONE) = (2^128) / (3 * 2^64) = 2^64 / 3
      expectClose(result, expected, 1n); // should be exact for integer division
    });

    it('division by zero throws', () => {
      expect(() => fixedDiv(ONE, 0n)).toThrow('Division by zero');
    });

    it('0 / x = 0', () => {
      expect(fixedDiv(0n, ONE)).toBe(0n);
      expect(fixedDiv(0n, ONE * 42n)).toBe(0n);
    });

    it('x / x = 1.0', () => {
      const x = ONE * 17n;
      expect(fixedDiv(x, x)).toBe(ONE);
    });

    it('mul and div are inverse operations', () => {
      const a = ONE * 5n;
      const b = ONE * 3n;
      const product = fixedMul(a, b);
      const recovered = fixedDiv(product, b);
      expectClose(recovered, a, 1n);
    });
  });

  describe('fixedLog2 - binary logarithm', () => {
    it('log2(1.0) = 0', () => {
      expect(fixedLog2(ONE)).toBe(0n);
    });

    it('log2(2.0) = 1.0', () => {
      const result = fixedLog2(ONE * 2n);
      expectClose(result, ONE);
    });

    it('log2(4.0) = 2.0', () => {
      const result = fixedLog2(ONE * 4n);
      expectClose(result, ONE * 2n);
    });

    it('log2(8.0) = 3.0', () => {
      const result = fixedLog2(ONE * 8n);
      expectClose(result, ONE * 3n);
    });

    it('log2(0.5) = -1.0', () => {
      const result = fixedLog2(ONE / 2n);
      expectClose(result, -ONE);
    });

    it('log2(0.25) = -2.0', () => {
      const result = fixedLog2(ONE / 4n);
      expectClose(result, -(ONE * 2n));
    });

    it('log2(0) throws', () => {
      expect(() => fixedLog2(0n)).toThrow();
    });

    it('log2(negative) throws', () => {
      expect(() => fixedLog2(-ONE)).toThrow();
    });

    it('log2(1.5) ≈ 0.585', () => {
      const result = fixedLog2(ONE + ONE / 2n); // 1.5
      const expected = toFixed(Math.log2(1.5));
      expectClose(result, expected);
    });
  });

  describe('fixedPow2 - power of 2', () => {
    it('pow2(0) = 1.0', () => {
      const result = fixedPow2(0n);
      expect(result).toBe(ONE);
    });

    it('pow2(1.0) = 2.0', () => {
      const result = fixedPow2(ONE);
      expectClose(result, ONE * 2n);
    });

    it('pow2(2.0) = 4.0', () => {
      const result = fixedPow2(ONE * 2n);
      expectClose(result, ONE * 4n);
    });

    it('pow2(3.0) = 8.0', () => {
      const result = fixedPow2(ONE * 3n);
      expectClose(result, ONE * 8n);
    });

    it('pow2(-1.0) = 0.5', () => {
      const result = fixedPow2(-ONE);
      expectClose(result, ONE / 2n);
    });

    it('pow2(-2.0) = 0.25', () => {
      const result = fixedPow2(-(ONE * 2n));
      expectClose(result, ONE / 4n);
    });

    it('pow2(0.5) ≈ sqrt(2) ≈ 1.41421', () => {
      const result = fixedPow2(ONE / 2n);
      const expected = toFixed(Math.SQRT2);
      expectClose(result, expected);
    });
  });

  describe('fixedExp - natural exponential (e^x)', () => {
    it('exp(0) = 1.0', () => {
      const result = fixedExp(0n);
      expect(result).toBe(ONE);
    });

    it('exp(1.0) ≈ 2.71828', () => {
      const result = fixedExp(ONE);
      const expected = toFixed(Math.E);
      expectClose(result, expected);
    });

    it('exp(-1.0) ≈ 0.36788', () => {
      const result = fixedExp(-ONE);
      const expected = toFixed(1 / Math.E);
      expectClose(result, expected);
    });

    it('exp(2.0) ≈ 7.389', () => {
      const result = fixedExp(ONE * 2n);
      const expected = toFixed(Math.exp(2));
      expectClose(result, expected);
    });

    it('exp(-2.0) ≈ 0.1353', () => {
      const result = fixedExp(-(ONE * 2n));
      const expected = toFixed(Math.exp(-2));
      expectClose(result, expected);
    });

    it('exp(0.5) ≈ 1.6487', () => {
      const result = fixedExp(ONE / 2n);
      const expected = toFixed(Math.exp(0.5));
      expectClose(result, expected);
    });
  });

  describe('fixedLn - natural logarithm', () => {
    it('ln(1.0) = 0', () => {
      const result = fixedLn(ONE);
      expectClose(result, 0n);
    });

    it('ln(e) ≈ 1.0', () => {
      const e = toFixed(Math.E);
      const result = fixedLn(e);
      expectClose(result, ONE);
    });

    it('ln(2.0) ≈ 0.6931 (equals LN_2)', () => {
      const result = fixedLn(ONE * 2n);
      expectClose(result, LN_2);
    });

    it('ln(0.5) ≈ -0.6931', () => {
      const result = fixedLn(ONE / 2n);
      const expected = toFixed(Math.log(0.5));
      expectClose(result, expected);
    });

    it('ln(0) throws', () => {
      expect(() => fixedLn(0n)).toThrow();
    });

    it('ln(negative) throws', () => {
      expect(() => fixedLn(-ONE)).toThrow();
    });

    it('ln(10.0) ≈ 2.3026', () => {
      const result = fixedLn(ONE * 10n);
      const expected = toFixed(Math.log(10));
      expectClose(result, expected);
    });
  });

  describe('Consistency between functions', () => {
    it('exp(ln(x)) ≈ x for x = 2.0', () => {
      const x = ONE * 2n;
      const lnx = fixedLn(x);
      const recovered = fixedExp(lnx);
      expectClose(recovered, x);
    });

    it('pow2(log2(x)) ≈ x for x = 5.0', () => {
      const x = ONE * 5n;
      const log2x = fixedLog2(x);
      const recovered = fixedPow2(log2x);
      expectClose(recovered, x);
    });

    it('ln(x) = log2(x) * LN_2', () => {
      const x = ONE * 3n;
      const lnx = fixedLn(x);
      const log2x = fixedLog2(x);
      const lnViaLog2 = fixedMul(log2x, LN_2);
      expectClose(lnx, lnViaLog2);
    });

    it('exp(x) = pow2(x * LOG2_E)', () => {
      const x = ONE; // 1.0
      const expx = fixedExp(x);
      const xTimesLog2E = fixedMul(x, LOG2_E);
      const pow2Result = fixedPow2(xTimesLog2E);
      expectClose(expx, pow2Result);
    });
  });

  describe('Utility functions', () => {
    it('toFixed converts float to Q64.64', () => {
      expect(toFixed(1.0)).toBe(ONE);
      expect(toFixed(2.0)).toBe(ONE * 2n);
      expect(toFixed(0.5)).toBe(ONE / 2n);
    });

    it('fromFixed converts Q64.64 to float', () => {
      expect(fromFixed(ONE)).toBeCloseTo(1.0);
      expect(fromFixed(ONE * 2n)).toBeCloseTo(2.0);
      expect(fromFixed(ONE / 2n)).toBeCloseTo(0.5);
    });

    it('toFixed and fromFixed are approximate inverses', () => {
      const values = [0.1, 0.5, 1.0, 2.5, 10.0, 100.0];
      for (const v of values) {
        const roundTrip = fromFixed(toFixed(v));
        expect(roundTrip).toBeCloseTo(v, 10); // ~10 decimal places of precision
      }
    });
  });
});
