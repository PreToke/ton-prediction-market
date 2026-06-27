/**
 * Property-based tests for deterministic ID derivation functions.
 *
 * Validates: Requirements 3.3
 *
 * Properties tested:
 * 1. Determinism of getConditionId — same inputs always produce the same output
 * 2. Determinism of getCollectionId — same inputs always produce the same output
 * 3. Determinism of getPositionId — same inputs always produce the same output
 * 4. Collision resistance of getConditionId — different inputs produce different outputs
 * 5. Full chain determinism — condition → collection → position derivation is consistent
 */

import { describe, it, expect } from 'vitest';
import { Address } from '@ton/core';
import * as fc from 'fast-check';
import './setup';

import {
  getConditionId,
  getCollectionId,
  getPositionId,
} from './id_derivation.test';

// ————————————————————————————————————————————
//   Arbitraries
// ————————————————————————————————————————————

/** Arbitrary for a uint256 bigint value (0 to 2^256 - 1) */
const uint256Arb = fc.bigInt({ min: 0n, max: 2n ** 256n - 1n });

/** Arbitrary for outcome slot count (valid range: 2 to 255, stored as uint8) */
const outcomeSlotCountArb = fc.integer({ min: 2, max: 255 });

/** Arbitrary for a TON Address (workchain 0, random 32-byte hash) */
const addressArb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => new Address(0, Buffer.from(bytes)));

// ————————————————————————————————————————————
//   Property Tests
// ————————————————————————————————————————————

describe('ID Derivation – Property-Based Tests', () => {
  describe('Determinism: getConditionId', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * For any random oracle address, questionId, and outcomeSlotCount,
     * computing the condition ID twice with the same inputs yields identical results.
     */
    it('computing getConditionId twice with the same inputs produces identical results', () => {
      fc.assert(
        fc.property(
          addressArb,
          uint256Arb,
          outcomeSlotCountArb,
          (oracle, questionId, outcomeSlotCount) => {
            const id1 = getConditionId(oracle, questionId, outcomeSlotCount);
            const id2 = getConditionId(oracle, questionId, outcomeSlotCount);
            expect(id1).toBe(id2);
          },
        ),
      );
    });
  });

  describe('Determinism: getCollectionId', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * For any random parentCollectionId, conditionId, and indexSet,
     * computing the collection ID twice with the same inputs yields identical results.
     */
    it('computing getCollectionId twice with the same inputs produces identical results', () => {
      fc.assert(
        fc.property(
          uint256Arb,
          uint256Arb,
          uint256Arb,
          (parentCollectionId, conditionId, indexSet) => {
            const id1 = getCollectionId(parentCollectionId, conditionId, indexSet);
            const id2 = getCollectionId(parentCollectionId, conditionId, indexSet);
            expect(id1).toBe(id2);
          },
        ),
      );
    });
  });

  describe('Determinism: getPositionId', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * For any random collateral address and collectionId,
     * computing the position ID twice with the same inputs yields identical results.
     */
    it('computing getPositionId twice with the same inputs produces identical results', () => {
      fc.assert(
        fc.property(
          addressArb,
          uint256Arb,
          (collateral, collectionId) => {
            const id1 = getPositionId(collateral, collectionId);
            const id2 = getPositionId(collateral, collectionId);
            expect(id1).toBe(id2);
          },
        ),
      );
    });
  });

  describe('Collision resistance: getConditionId', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * For two different random inputs to getConditionId, the outputs should differ.
     * With SHA-256 producing 256-bit hashes, the probability of collision is negligible.
     */
    it('different inputs to getConditionId produce different outputs', () => {
      fc.assert(
        fc.property(
          addressArb,
          uint256Arb,
          outcomeSlotCountArb,
          addressArb,
          uint256Arb,
          outcomeSlotCountArb,
          (oracle1, questionId1, slotCount1, oracle2, questionId2, slotCount2) => {
            // Only test when inputs actually differ
            const inputsDiffer =
              !oracle1.equals(oracle2) ||
              questionId1 !== questionId2 ||
              slotCount1 !== slotCount2;

            fc.pre(inputsDiffer);

            const id1 = getConditionId(oracle1, questionId1, slotCount1);
            const id2 = getConditionId(oracle2, questionId2, slotCount2);
            expect(id1).not.toBe(id2);
          },
        ),
      );
    });
  });

  describe('Full chain determinism', () => {
    /**
     * **Validates: Requirements 3.3**
     *
     * For random inputs through the full derivation chain
     * (condition → collection → position), the final position ID
     * is consistent across multiple computations.
     */
    it('full derivation chain produces consistent results', () => {
      fc.assert(
        fc.property(
          addressArb,
          uint256Arb,
          outcomeSlotCountArb,
          uint256Arb,
          addressArb,
          (oracle, questionId, outcomeSlotCount, indexSet, collateral) => {
            // First pass through the full chain
            const conditionId1 = getConditionId(oracle, questionId, outcomeSlotCount);
            const collectionId1 = getCollectionId(0n, conditionId1, indexSet);
            const positionId1 = getPositionId(collateral, collectionId1);

            // Second pass through the full chain
            const conditionId2 = getConditionId(oracle, questionId, outcomeSlotCount);
            const collectionId2 = getCollectionId(0n, conditionId2, indexSet);
            const positionId2 = getPositionId(collateral, collectionId2);

            // All intermediate and final results must match
            expect(conditionId1).toBe(conditionId2);
            expect(collectionId1).toBe(collectionId2);
            expect(positionId1).toBe(positionId2);
          },
        ),
      );
    });
  });
});
