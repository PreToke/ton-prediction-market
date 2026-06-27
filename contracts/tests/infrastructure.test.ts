/**
 * Infrastructure smoke tests.
 *
 * Verifies that the test tooling (TON Sandbox, fast-check, Vitest) is
 * correctly configured and can run both unit tests and property-based tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano, Cell } from '@ton/core';
import * as fc from 'fast-check';
import { getPbtNumRuns, TEST_CONSTANTS } from './setup';

describe('Test Infrastructure', () => {
  describe('TON Sandbox', () => {
    let blockchain: Blockchain;
    let treasury: SandboxContract<TreasuryContract>;

    beforeAll(async () => {
      blockchain = await Blockchain.create();
      treasury = await blockchain.treasury('test-wallet');
    });

    it('should create a blockchain instance', () => {
      expect(blockchain).toBeDefined();
    });

    it('should create a treasury with balance', async () => {
      expect(treasury).toBeDefined();
      expect(treasury.address).toBeDefined();
    });

    it('should send TON between wallets', async () => {
      const receiver = await blockchain.treasury('receiver');
      const sendResult = await treasury.send({
        to: receiver.address,
        value: toNano('1'),
        body: Cell.EMPTY,
      });
      expect(sendResult.transactions.length).toBeGreaterThan(0);
    });
  });

  describe('fast-check Property-Based Testing', () => {
    it('should be configured with correct number of runs', () => {
      const numRuns = getPbtNumRuns();
      expect(numRuns).toBeGreaterThanOrEqual(100);
    });

    it('should run property tests with fast-check', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
          // Simple property: doubling a positive number always yields a larger result
          return n * 2 > n;
        }),
      );
    });

    it('should support bigint arbitraries for TON amounts', () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 0n, max: toNano('1000') }),
          fc.bigInt({ min: 0n, max: toNano('1000') }),
          (a, b) => {
            // Property: addition of non-negative amounts is commutative
            return a + b === b + a;
          },
        ),
      );
    });

    it('should support custom arbitraries for outcome counts', () => {
      const outcomeCountArb = fc.integer({
        min: TEST_CONSTANTS.MIN_OUTCOMES,
        max: TEST_CONSTANTS.MAX_OUTCOMES,
      });

      fc.assert(
        fc.property(outcomeCountArb, (outcomeCount) => {
          // Property: outcome count is always within valid bounds
          return (
            outcomeCount >= TEST_CONSTANTS.MIN_OUTCOMES &&
            outcomeCount <= TEST_CONSTANTS.MAX_OUTCOMES
          );
        }),
      );
    });

    it('should support Q64.64 fixed-point property testing', () => {
      const fixedPointArb = fc.bigInt({
        min: 1n,
        max: TEST_CONSTANTS.FIXED_POINT_ONE * 100n, // Up to 100.0 in fixed-point
      });

      fc.assert(
        fc.property(fixedPointArb, (x) => {
          // Property: fixed-point values maintain ordering with raw bigint comparison
          return x > 0n;
        }),
      );
    });
  });
});
