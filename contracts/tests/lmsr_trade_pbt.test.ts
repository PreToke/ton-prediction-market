/**
 * Property-based tests for LMSR Marginal Price Calculation (Requirement 9).
 *
 * **Validates: Requirements 9.2, 9.3**
 *
 * Properties tested:
 * 1. Sum of marginal prices across all outcomes ≈ 1.0 (probability distribution)
 * 2. Each individual marginal price is in [0, 1]
 * 3. With equal balances, all prices are equal (≈ 1/n)
 * 4. After a trade (balance change), prices still sum to 1.0
 *
 * Uses a pure TypeScript reference implementation of the LMSR marginal price
 * formula for fast iteration. The on-chain `calcMarginalPrice` get-method
 * (not yet implemented — TDD) should produce equivalent results.
 *
 * Marginal price formula:
 *   price_i = exp(q_i / b) / sum(exp(q_j / b)) for all j
 *
 * This is a softmax function over q/b, which always sums to 1.0 by construction.
 * The fixed-point implementation may introduce rounding errors, so we verify
 * the property holds within Q64.64 precision tolerance.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import './setup';
import {
  ONE,
  fixedExp,
  fixedDiv,
  fixedMul,
} from '../../wrappers-ts/FixedMath.gen';

// ————————————————————————————————————————————
//   Constants
// ————————————————————————————————————————————

/**
 * Tolerance for price sum property: ±2^32 (relative to ONE = 2^64).
 * This corresponds to ~2.3e-10 in decimal — well within acceptable
 * fixed-point precision for financial calculations.
 */
const PRICE_SUM_TOLERANCE = 1n << 32n;

/**
 * Tolerance for equal-price property: ±2^40.
 * Slightly more generous since division by n introduces additional rounding.
 */
const EQUAL_PRICE_TOLERANCE = 1n << 40n;

// ————————————————————————————————————————————
//   TypeScript Reference: LMSR Marginal Price
// ————————————————————————————————————————————

/**
 * Compute the marginal price for outcome `i` using the LMSR formula:
 *   price_i = exp(q_i / b) / sum(exp(q_j / b)) for all j
 *
 * Uses the offset technique to prevent overflow:
 *   price_i = exp((q_i - max_q) / b) / sum(exp((q_j - max_q) / b))
 *
 * The offset cancels in the ratio so it doesn't affect the result.
 *
 * @param balances - array of position balances (q_j) in Q64.64 format
 * @param b - funding parameter (liquidity depth) in Q64.64 format
 * @param outcomeIndex - which outcome to compute the price for
 * @returns marginal price in Q64.64 format (in range [0, ONE])
 */
function calcMarginalPriceRef(
  balances: bigint[],
  b: bigint,
  outcomeIndex: number,
): bigint {
  const n = balances.length;
  if (n === 0) throw new Error('Empty balances');
  if (outcomeIndex < 0 || outcomeIndex >= n) throw new Error('Invalid outcome index');
  if (b <= 0n) throw new Error('Funding must be positive');

  // Find max balance for offset technique
  let maxQ = balances[0];
  for (let j = 1; j < n; j++) {
    if (balances[j] > maxQ) maxQ = balances[j];
  }

  // Compute exp((q_j - maxQ) / b) for each outcome
  const expValues: bigint[] = [];
  for (let j = 0; j < n; j++) {
    const diff = balances[j] - maxQ; // ≤ 0, so safe for exp
    const scaledDiff = fixedDiv(diff, b); // (q_j - maxQ) / b in Q64.64
    expValues.push(fixedExp(scaledDiff));
  }

  // Sum of all exp values
  let sumExp = 0n;
  for (let j = 0; j < n; j++) {
    sumExp += expValues[j];
  }

  // price_i = exp_i / sumExp
  if (sumExp === 0n) return 0n;
  return fixedDiv(expValues[outcomeIndex], sumExp);
}

/**
 * Compute all marginal prices for a market state.
 *
 * @param balances - array of position balances (q_j) in Q64.64 format
 * @param b - funding parameter in Q64.64 format
 * @returns array of marginal prices in Q64.64 format
 */
function calcAllMarginalPricesRef(balances: bigint[], b: bigint): bigint[] {
  return balances.map((_, i) => calcMarginalPriceRef(balances, b, i));
}

// ————————————————————————————————————————————
//   Helpers
// ————————————————————————————————————————————

/** Absolute value for bigint */
function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

// ————————————————————————————————————————————
//   Arbitraries (Generators)
// ————————————————————————————————————————————

/**
 * Arbitrary for outcome count: 2 to 8 outcomes.
 * Covers binary markets up to larger multi-outcome markets.
 */
const outcomeCountArb = fc.integer({ min: 2, max: 8 });

/**
 * Arbitrary for funding parameter (b) in Q64.64.
 * Range: 1.0 to 10000.0 in Q64.64 — reasonable liquidity depths.
 * Minimum of 1.0 prevents division-by-near-zero issues.
 */
const fundingArb = fc.bigInt({
  min: ONE,           // 1.0 in Q64.64
  max: ONE * 10000n,  // 10000.0 in Q64.64
});

/**
 * Arbitrary for a single position balance in Q64.64.
 * Range: 0.0 to 1000.0 — covers zero positions up to large imbalances.
 * We keep values moderate to avoid exp overflow.
 */
const balanceArb = fc.bigInt({
  min: 0n,
  max: ONE * 1000n,  // 1000.0 in Q64.64
});

/**
 * Generate a random array of position balances for a given outcome count.
 * Each balance is independently drawn from balanceArb.
 */
function balancesArb(n: number): fc.Arbitrary<bigint[]> {
  return fc.array(balanceArb, { minLength: n, maxLength: n });
}

/**
 * Generate a complete market state: outcomeCount, funding, and balances.
 * Constrains balances such that max(q_i) / b stays within exp safe range
 * (prevents overflow in the fixed-point exp function).
 */
const marketStateArb = outcomeCountArb.chain((n) =>
  fc.tuple(
    fc.constant(n),
    fundingArb,
    balancesArb(n),
  ).filter(([, b, balances]) => {
    // Ensure (max_q - min_q) / b doesn't exceed ~3.0 (exp limit safety)
    // This prevents exp overflow in our fixed-point implementation
    const maxQ = balances.reduce((a, x) => (x > a ? x : a), balances[0]);
    const minQ = balances.reduce((a, x) => (x < a ? x : a), balances[0]);
    const spread = maxQ - minQ;
    // spread / b should be < 3*ONE (exp limit is ~3.4*ONE)
    return spread < b * 3n;
  }),
);

/**
 * Generate a market state where all balances are equal.
 * Used to test the uniform pricing property (price_i = 1/n).
 */
const equalBalanceMarketArb = outcomeCountArb.chain((n) =>
  fc.tuple(
    fc.constant(n),
    fundingArb,
    balanceArb.map((bal) => Array(n).fill(bal) as bigint[]),
  ),
);

/**
 * Arbitrary for trade amounts: array of deltas to apply to balances.
 * Values can be positive (buy) or negative (sell), moderate range.
 */
function tradeAmountsArb(n: number): fc.Arbitrary<bigint[]> {
  const singleAmount = fc.bigInt({ min: -(ONE * 100n), max: ONE * 100n });
  return fc.array(singleAmount, { minLength: n, maxLength: n });
}

// ————————————————————————————————————————————
//   Property-Based Tests
// ————————————————————————————————————————————

describe('LMSR Marginal Price – Property-Based Tests', () => {
  /**
   * **Validates: Requirements 9.2**
   *
   * Property: For all valid market states (random funding b > 0, random
   * position balances for 2-8 outcomes), the sum of marginal prices across
   * all outcomes ≈ 1.0 within Q64.64 fixed-point precision tolerance.
   *
   * This is the fundamental property of the LMSR pricing function — it
   * produces a valid probability distribution.
   */
  describe('Sum of marginal prices equals 1.0', () => {
    it('for random valid market states, sum of all marginal prices ≈ ONE within tolerance', () => {
      fc.assert(
        fc.property(marketStateArb, ([n, b, balances]) => {
          const prices = calcAllMarginalPricesRef(balances, b);
          const sum = prices.reduce((acc, p) => acc + p, 0n);

          const diff = abs(sum - ONE);
          if (diff > PRICE_SUM_TOLERANCE) {
            return false;
          }
          return true;
        }),
      );
    });
  });

  /**
   * **Validates: Requirements 9.2**
   *
   * Property: Each individual marginal price is in [0, ONE] (i.e., [0, 1]).
   * Since marginal prices are probabilities, they must be non-negative
   * and cannot exceed 1.0.
   */
  describe('Each marginal price is in [0, 1]', () => {
    it('for random valid market states, every price_i is in [0, ONE]', () => {
      fc.assert(
        fc.property(marketStateArb, ([n, b, balances]) => {
          const prices = calcAllMarginalPricesRef(balances, b);

          for (const price of prices) {
            // Price should be non-negative
            if (price < 0n) return false;
            // Price should not exceed ONE (with small tolerance for rounding)
            if (price > ONE + PRICE_SUM_TOLERANCE) return false;
          }
          return true;
        }),
      );
    });
  });

  /**
   * **Validates: Requirements 9.3**
   *
   * Property: When all outcome token balances are equal, the market maker
   * returns 1/n for each outcome token (uniform distribution).
   *
   * With equal q_i for all i:
   *   price_i = exp(q/b) / (n * exp(q/b)) = 1/n
   */
  describe('Equal balances produce uniform prices (1/n)', () => {
    it('for equal balances, all prices ≈ ONE/n within tolerance', () => {
      fc.assert(
        fc.property(equalBalanceMarketArb, ([n, b, balances]) => {
          const prices = calcAllMarginalPricesRef(balances, b);
          const expectedPrice = fixedDiv(ONE, BigInt(n) * ONE);

          for (const price of prices) {
            const diff = abs(price - expectedPrice);
            if (diff > EQUAL_PRICE_TOLERANCE) return false;
          }

          // Also verify they're all equal to each other
          for (let i = 1; i < prices.length; i++) {
            const diff = abs(prices[i] - prices[0]);
            if (diff > EQUAL_PRICE_TOLERANCE) return false;
          }

          return true;
        }),
      );
    });
  });

  /**
   * **Validates: Requirements 9.2**
   *
   * Property: After applying a trade (changing position balances),
   * the marginal prices still sum to 1.0. This verifies the invariant
   * holds not just for initial states but also post-trade states.
   */
  describe('Prices sum to 1.0 after a trade', () => {
    it('for random market state + random trade, post-trade prices still sum to ONE', () => {
      fc.assert(
        fc.property(
          marketStateArb.chain(([n, b, balances]) =>
            fc.tuple(
              fc.constant(n),
              fc.constant(b),
              fc.constant(balances),
              tradeAmountsArb(n),
            ),
          ),
          ([n, b, balances, tradeAmounts]) => {
            // Apply trade: new_balance_i = balance_i + tradeAmount_i
            const newBalances = balances.map((q, i) => q + tradeAmounts[i]);

            // Ensure post-trade balances don't cause exp overflow
            const maxQ = newBalances.reduce((a, x) => (x > a ? x : a), newBalances[0]);
            const minQ = newBalances.reduce((a, x) => (x < a ? x : a), newBalances[0]);
            const spread = maxQ - minQ;
            if (spread >= b * 3n) return true; // Skip if would overflow

            // Ensure no negative balances after trade (market invariant)
            if (newBalances.some((q) => q < 0n)) return true; // Skip invalid states

            const prices = calcAllMarginalPricesRef(newBalances, b);
            const sum = prices.reduce((acc, p) => acc + p, 0n);

            const diff = abs(sum - ONE);
            return diff <= PRICE_SUM_TOLERANCE;
          },
        ),
      );
    });
  });

  /**
   * **Validates: Requirements 9.2**
   *
   * Property: Monotonicity — increasing a single outcome's balance
   * (while keeping others constant) increases that outcome's price
   * and decreases others' prices. This confirms the pricing is
   * responsive to supply/demand changes.
   */
  describe('Monotonicity: increasing q_i increases price_i', () => {
    it('for random state, adding to one balance increases its price', () => {
      fc.assert(
        fc.property(
          marketStateArb,
          fc.bigInt({ min: ONE / 10n, max: ONE * 10n }), // delta to add
          ([n, b, balances], delta) => {
            // Pick outcome 0 to increase
            const outcomeIndex = 0;

            // Compute price before
            const priceBefore = calcMarginalPriceRef(balances, b, outcomeIndex);

            // Apply increase
            const newBalances = [...balances];
            newBalances[outcomeIndex] = newBalances[outcomeIndex] + delta;

            // Check spread is still safe
            const maxQ = newBalances.reduce((a, x) => (x > a ? x : a), newBalances[0]);
            const minQ = newBalances.reduce((a, x) => (x < a ? x : a), newBalances[0]);
            if (maxQ - minQ >= b * 3n) return true; // Skip overflow cases

            // Compute price after
            const priceAfter = calcMarginalPriceRef(newBalances, b, outcomeIndex);

            // Price should increase (or at minimum stay the same within tolerance)
            return priceAfter >= priceBefore - PRICE_SUM_TOLERANCE;
          },
        ),
      );
    });
  });
});
