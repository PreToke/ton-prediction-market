/**
 * Property-based tests for the Fixed-Point Math Library (Q64.64 format).
 *
 * Uses fast-check to validate mathematical properties hold across random inputs:
 * - Round-trip identities (exp/ln, pow2/log2)
 * - Monotonicity (exp, ln)
 * - Homomorphism (exp(a+b) ≈ exp(a) * exp(b))
 * - Algebraic identities (mul/div by ONE)
 *
 * **Validates: Requirements 15.1**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import './setup';
import {
  ONE,
  fixedMul,
  fixedDiv,
  fixedExp,
  fixedLn,
  fixedLog2,
  fixedPow2,
} from '../../wrappers-ts/FixedMath.gen';

/**
 * Tolerance for round-trip properties: ±2^46.
 * Slightly more generous than unit tests due to accumulated error
 * from composing two transcendental functions.
 */
const PBT_TOLERANCE = 1n << 46n;

/** Helper: absolute value for bigint */
function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/** Helper: assert two Q64.64 values are within tolerance */
function expectClose(actual: bigint, expected: bigint, tol: bigint = PBT_TOLERANCE) {
  const diff = abs(actual - expected);
  expect(diff).toBeLessThanOrEqual(tol);
}

/**
 * Arbitrary for valid ln input: x in (0.01*ONE, 100*ONE].
 * We avoid values very close to zero where relative error is amplified.
 */
const lnInputArb = fc.bigInt({
  min: ONE / 100n,        // 0.01 in Q64.64
  max: ONE * 100n,        // 100.0 in Q64.64
});

/**
 * Arbitrary for valid exp input: x in (-3*ONE, 3*ONE).
 * Stays well within EXP_LIMIT (~3.4*ONE) to avoid overflow.
 */
const expInputArb = fc.bigInt({
  min: -(ONE * 3n),       // -3.0 in Q64.64
  max: ONE * 3n,          // 3.0 in Q64.64
});

/**
 * Arbitrary for valid pow2/log2 input: x in (0.01*ONE, 100*ONE].
 */
const log2InputArb = fc.bigInt({
  min: ONE / 100n,
  max: ONE * 100n,
});

/**
 * Arbitrary for valid fixed-point values (for mul/div identity tests).
 * Covers a wide range including fractions and large values.
 */
const validFixedArb = fc.bigInt({
  min: 1n,                 // smallest positive
  max: ONE * 1000n,        // 1000.0 in Q64.64
});

/**
 * Arbitrary for homomorphism test: a, b such that a+b is in safe exp range.
 * We use smaller values to ensure a+b stays within (-3*ONE, 3*ONE).
 */
const expHomomorphismArb = fc.bigInt({
  min: -(ONE * 3n) / 2n,  // -1.5 in Q64.64
  max: (ONE * 3n) / 2n,   // 1.5 in Q64.64
});

describe('Fixed-Point Math - Property-Based Tests', () => {
  describe('Round-trip: exp(ln(x)) ≈ x', () => {
    it('for random x in valid range, exp(ln(x)) ≈ x within tolerance', () => {
      fc.assert(
        fc.property(lnInputArb, (x) => {
          const lnX = fixedLn(x);
          const recovered = fixedExp(lnX);
          const diff = abs(recovered - x);
          // Use relative tolerance for larger values
          const relativeTol = (x * PBT_TOLERANCE) / ONE;
          const tol = relativeTol > PBT_TOLERANCE ? relativeTol : PBT_TOLERANCE;
          return diff <= tol;
        }),
      );
    });
  });

  describe('Round-trip: pow2(log2(x)) ≈ x', () => {
    it('for random x > 0, pow2(log2(x)) ≈ x within tolerance', () => {
      fc.assert(
        fc.property(log2InputArb, (x) => {
          const log2X = fixedLog2(x);
          const recovered = fixedPow2(log2X);
          const diff = abs(recovered - x);
          const relativeTol = (x * PBT_TOLERANCE) / ONE;
          const tol = relativeTol > PBT_TOLERANCE ? relativeTol : PBT_TOLERANCE;
          return diff <= tol;
        }),
      );
    });
  });

  describe('Round-trip: ln(exp(x)) ≈ x', () => {
    it('for random x in safe range, ln(exp(x)) ≈ x within tolerance', () => {
      fc.assert(
        fc.property(expInputArb, (x) => {
          const expX = fixedExp(x);
          // exp(x) must be > 0 for ln (it always is for finite x)
          if (expX <= 0n) return true; // skip degenerate cases
          const recovered = fixedLn(expX);
          const diff = abs(recovered - x);
          // For values near zero, use absolute tolerance
          const absTol = PBT_TOLERANCE;
          // For larger values, use relative tolerance
          const relativeTol = abs(x) > ONE ? (abs(x) * PBT_TOLERANCE) / ONE : absTol;
          const tol = relativeTol > absTol ? relativeTol : absTol;
          return diff <= tol;
        }),
      );
    });
  });

  describe('Monotonicity: x1 < x2 → exp(x1) ≤ exp(x2)', () => {
    it('exp is non-decreasing for random x1, x2 (strictly increasing for separated inputs)', () => {
      fc.assert(
        fc.property(expInputArb, expInputArb, (a, b) => {
          const x1 = a < b ? a : b;
          const x2 = a < b ? b : a;
          if (x1 === x2) return true; // skip equal values
          const exp1 = fixedExp(x1);
          const exp2 = fixedExp(x2);
          // Non-decreasing: exp(x1) <= exp(x2)
          if (exp1 > exp2) return false;
          // For well-separated inputs, strictly increasing
          if (x2 - x1 > ONE / 1000n) {
            return exp1 < exp2;
          }
          return true;
        }),
      );
    });
  });

  describe('Monotonicity: x1 < x2 → ln(x1) ≤ ln(x2)', () => {
    it('ln is non-decreasing for random x1, x2 > 0 (strictly increasing for separated inputs)', () => {
      fc.assert(
        fc.property(lnInputArb, lnInputArb, (a, b) => {
          const x1 = a < b ? a : b;
          const x2 = a < b ? b : a;
          if (x1 === x2) return true; // skip equal values
          const ln1 = fixedLn(x1);
          const ln2 = fixedLn(x2);
          // Non-decreasing: ln(x1) <= ln(x2)
          if (ln1 > ln2) return false;
          // For well-separated inputs, strictly increasing
          if (x2 - x1 > ONE / 1000n) {
            return ln1 < ln2;
          }
          return true;
        }),
      );
    });
  });

  describe('Homomorphism: exp(a+b) ≈ exp(a) * exp(b)', () => {
    it('exp distributes over addition within tolerance', () => {
      fc.assert(
        fc.property(expHomomorphismArb, expHomomorphismArb, (a, b) => {
          const sum = a + b;
          // Ensure a+b is still in safe range
          if (sum > ONE * 3n || sum < -(ONE * 3n)) return true;

          const expSum = fixedExp(sum);
          const expA = fixedExp(a);
          const expB = fixedExp(b);
          const product = fixedMul(expA, expB);

          const diff = abs(expSum - product);
          // Use relative tolerance scaled to the magnitude of the result
          const magnitude = expSum > product ? expSum : product;
          const relativeTol = (magnitude * PBT_TOLERANCE) / ONE;
          const tol = relativeTol > PBT_TOLERANCE ? relativeTol : PBT_TOLERANCE;
          return diff <= tol;
        }),
      );
    });
  });

  describe('Identity: mul(x, ONE) = x', () => {
    it('multiplying by ONE returns x unchanged for all valid x', () => {
      fc.assert(
        fc.property(validFixedArb, (x) => {
          return fixedMul(x, ONE) === x && fixedMul(ONE, x) === x;
        }),
      );
    });
  });

  describe('Identity: div(x, ONE) = x', () => {
    it('dividing by ONE returns x unchanged for all valid x', () => {
      fc.assert(
        fc.property(validFixedArb, (x) => {
          return fixedDiv(x, ONE) === x;
        }),
      );
    });
  });
});
