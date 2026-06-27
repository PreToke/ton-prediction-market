/**
 * Unit tests for deterministic ID derivation functions.
 *
 * Tests the TypeScript reference implementations of get_condition_id,
 * get_collection_id, and get_position_id which use SHA-256 cell hashing
 * with canonical serialization via @ton/core.
 *
 * ID derivation rules (from design.md):
 *
 * condition_id = cell_hash(
 *   begin_cell()
 *     .store_slice(oracle_address)
 *     .store_uint(question_id, 256)
 *     .store_uint(outcome_slot_count, 8)
 *   .end_cell()
 * )
 *
 * collection_id = cell_hash(
 *   begin_cell()
 *     .store_uint(parent_collection_id, 256)
 *     .store_uint(condition_id, 256)
 *     .store_uint(index_set, 256)
 *   .end_cell()
 * )
 *
 * position_id = cell_hash(
 *   begin_cell()
 *     .store_slice(collateral_token_address)
 *     .store_uint(collection_id, 256)
 *   .end_cell()
 * )
 */

import { describe, it, expect } from 'vitest';
import { beginCell, Address } from '@ton/core';

// ————————————————————————————————————————————
//   TypeScript Reference Implementations
// ————————————————————————————————————————————

/**
 * Compute condition_id as SHA-256 hash of the canonical cell serialization.
 *
 * @param oracle - Oracle address (MsgAddress)
 * @param questionId - Question identifier (uint256)
 * @param outcomeSlotCount - Number of outcome slots (uint8)
 * @returns condition_id as bigint (256-bit hash)
 */
export function getConditionId(
  oracle: Address,
  questionId: bigint,
  outcomeSlotCount: number,
): bigint {
  const cell = beginCell()
    .storeAddress(oracle)
    .storeUint(questionId, 256)
    .storeUint(outcomeSlotCount, 8)
    .endCell();

  const hash = cell.hash();
  return BigInt('0x' + hash.toString('hex'));
}

/**
 * Compute collection_id as SHA-256 hash of the canonical cell serialization.
 *
 * @param parentCollectionId - Parent collection ID (0 for null/root)
 * @param conditionId - Condition ID (uint256)
 * @param indexSet - Index set bitmask (uint256)
 * @returns collection_id as bigint (256-bit hash)
 */
export function getCollectionId(
  parentCollectionId: bigint,
  conditionId: bigint,
  indexSet: bigint,
): bigint {
  const cell = beginCell()
    .storeUint(parentCollectionId, 256)
    .storeUint(conditionId, 256)
    .storeUint(indexSet, 256)
    .endCell();

  const hash = cell.hash();
  return BigInt('0x' + hash.toString('hex'));
}

/**
 * Compute position_id as SHA-256 hash of the canonical cell serialization.
 *
 * @param collateralToken - Collateral token address (MsgAddress)
 * @param collectionId - Collection ID (uint256)
 * @returns position_id as bigint (256-bit hash)
 */
export function getPositionId(
  collateralToken: Address,
  collectionId: bigint,
): bigint {
  const cell = beginCell()
    .storeAddress(collateralToken)
    .storeUint(collectionId, 256)
    .endCell();

  const hash = cell.hash();
  return BigInt('0x' + hash.toString('hex'));
}

// ————————————————————————————————————————————
//   Test Helpers
// ————————————————————————————————————————————

/** Create a deterministic test address from a seed string */
function testAddress(seed: number): Address {
  // Create a deterministic address using workchain 0 and a hash derived from the seed
  const buf = Buffer.alloc(32, 0);
  buf.writeUInt32BE(seed, 0);
  return new Address(0, buf);
}

// ————————————————————————————————————————————
//   Tests
// ————————————————————————————————————————————

describe('Deterministic ID Derivation', () => {
  // Fixed test addresses
  const oracle1 = testAddress(1);
  const oracle2 = testAddress(2);
  const collateral1 = testAddress(100);
  const collateral2 = testAddress(200);

  // Fixed test values
  const questionId1 = 1n;
  const questionId2 = 2n;
  const outcomeCount2 = 2;
  const outcomeCount3 = 3;

  describe('getConditionId', () => {
    it('computes a 256-bit hash for known inputs', () => {
      const id = getConditionId(oracle1, questionId1, outcomeCount2);

      // Should be a valid 256-bit value
      expect(id).toBeGreaterThan(0n);
      expect(id).toBeLessThan(2n ** 256n);
    });

    it('produces a non-zero result for valid inputs', () => {
      const id = getConditionId(oracle1, questionId1, outcomeCount2);
      expect(id).not.toBe(0n);
    });

    it('different oracle produces different ID', () => {
      const id1 = getConditionId(oracle1, questionId1, outcomeCount2);
      const id2 = getConditionId(oracle2, questionId1, outcomeCount2);

      expect(id1).not.toBe(id2);
    });

    it('different question_id produces different ID', () => {
      const id1 = getConditionId(oracle1, questionId1, outcomeCount2);
      const id2 = getConditionId(oracle1, questionId2, outcomeCount2);

      expect(id1).not.toBe(id2);
    });

    it('different outcome_count produces different ID', () => {
      const id1 = getConditionId(oracle1, questionId1, outcomeCount2);
      const id2 = getConditionId(oracle1, questionId1, outcomeCount3);

      expect(id1).not.toBe(id2);
    });

    it('determinism: same inputs always produce same output', () => {
      const id1 = getConditionId(oracle1, questionId1, outcomeCount2);
      const id2 = getConditionId(oracle1, questionId1, outcomeCount2);
      const id3 = getConditionId(oracle1, questionId1, outcomeCount2);

      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
    });

    it('handles large question_id values', () => {
      const largeQuestionId = 2n ** 255n - 1n;
      const id = getConditionId(oracle1, largeQuestionId, outcomeCount2);

      expect(id).toBeGreaterThan(0n);
      expect(id).toBeLessThan(2n ** 256n);
    });

    it('handles edge case outcome_count values', () => {
      // minimum valid (2 outcomes)
      const id2 = getConditionId(oracle1, questionId1, 2);
      // maximum for uint8 (255 outcomes)
      const id255 = getConditionId(oracle1, questionId1, 255);

      expect(id2).not.toBe(id255);
      expect(id2).toBeGreaterThan(0n);
      expect(id255).toBeGreaterThan(0n);
    });
  });

  describe('getCollectionId', () => {
    // Precompute a condition_id for use in collection tests
    const conditionId = getConditionId(oracle1, questionId1, outcomeCount2);
    const conditionId2 = getConditionId(oracle2, questionId1, outcomeCount2);

    const nullParent = 0n; // null parent collection
    const indexSet1 = 1n; // bit 0 set (outcome 0)
    const indexSet2 = 2n; // bit 1 set (outcome 1)
    const indexSet3 = 3n; // bits 0+1 set (outcomes 0 and 1)

    it('computes a 256-bit hash for known inputs', () => {
      const id = getCollectionId(nullParent, conditionId, indexSet1);

      expect(id).toBeGreaterThan(0n);
      expect(id).toBeLessThan(2n ** 256n);
    });

    it('null parent (0) produces valid collection ID', () => {
      const id = getCollectionId(nullParent, conditionId, indexSet1);
      expect(id).not.toBe(0n);
    });

    it('non-null parent produces different result than null parent', () => {
      const idWithNullParent = getCollectionId(nullParent, conditionId, indexSet1);

      // Use a non-zero parent (e.g., another condition's collection)
      const nonNullParent = getCollectionId(nullParent, conditionId2, indexSet1);
      const idWithParent = getCollectionId(nonNullParent, conditionId, indexSet1);

      expect(idWithNullParent).not.toBe(idWithParent);
    });

    it('different index_sets produce different IDs', () => {
      const id1 = getCollectionId(nullParent, conditionId, indexSet1);
      const id2 = getCollectionId(nullParent, conditionId, indexSet2);
      const id3 = getCollectionId(nullParent, conditionId, indexSet3);

      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);
      expect(id2).not.toBe(id3);
    });

    it('different condition_ids produce different collection IDs', () => {
      const id1 = getCollectionId(nullParent, conditionId, indexSet1);
      const id2 = getCollectionId(nullParent, conditionId2, indexSet1);

      expect(id1).not.toBe(id2);
    });

    it('determinism: same inputs always produce same output', () => {
      const id1 = getCollectionId(nullParent, conditionId, indexSet1);
      const id2 = getCollectionId(nullParent, conditionId, indexSet1);
      const id3 = getCollectionId(nullParent, conditionId, indexSet1);

      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
    });

    it('handles deep nesting (non-zero parent_collection_id)', () => {
      // Simulate multi-level collection nesting
      const level1 = getCollectionId(nullParent, conditionId, indexSet1);
      const level2 = getCollectionId(level1, conditionId2, indexSet2);

      expect(level2).toBeGreaterThan(0n);
      expect(level2).toBeLessThan(2n ** 256n);
      expect(level2).not.toBe(level1);
    });
  });

  describe('getPositionId', () => {
    // Precompute IDs for position tests
    const conditionId = getConditionId(oracle1, questionId1, outcomeCount2);
    const collectionId1 = getCollectionId(0n, conditionId, 1n);
    const collectionId2 = getCollectionId(0n, conditionId, 2n);

    it('computes a 256-bit hash for known inputs', () => {
      const id = getPositionId(collateral1, collectionId1);

      expect(id).toBeGreaterThan(0n);
      expect(id).toBeLessThan(2n ** 256n);
    });

    it('produces a non-zero result for valid inputs', () => {
      const id = getPositionId(collateral1, collectionId1);
      expect(id).not.toBe(0n);
    });

    it('different collateral produces different position ID', () => {
      const id1 = getPositionId(collateral1, collectionId1);
      const id2 = getPositionId(collateral2, collectionId1);

      expect(id1).not.toBe(id2);
    });

    it('different collection_id produces different position ID', () => {
      const id1 = getPositionId(collateral1, collectionId1);
      const id2 = getPositionId(collateral1, collectionId2);

      expect(id1).not.toBe(id2);
    });

    it('determinism: same inputs always produce same output', () => {
      const id1 = getPositionId(collateral1, collectionId1);
      const id2 = getPositionId(collateral1, collectionId1);
      const id3 = getPositionId(collateral1, collectionId1);

      expect(id1).toBe(id2);
      expect(id2).toBe(id3);
    });

    it('position IDs compose correctly through the full derivation chain', () => {
      // Full derivation: oracle + question → condition → collection → position
      const cid = getConditionId(oracle1, questionId1, outcomeCount2);
      const colId = getCollectionId(0n, cid, 1n); // outcome 0
      const posId = getPositionId(collateral1, colId);

      // Verify it's deterministic through the whole chain
      const cid2 = getConditionId(oracle1, questionId1, outcomeCount2);
      const colId2 = getCollectionId(0n, cid2, 1n);
      const posId2 = getPositionId(collateral1, colId2);

      expect(posId).toBe(posId2);
    });
  });

  describe('Cross-function uniqueness', () => {
    it('condition, collection, and position IDs are all different for related inputs', () => {
      const condId = getConditionId(oracle1, questionId1, outcomeCount2);
      const collId = getCollectionId(0n, condId, 1n);
      const posId = getPositionId(collateral1, collId);

      // All three IDs should be distinct (different cell structures → different hashes)
      expect(condId).not.toBe(collId);
      expect(condId).not.toBe(posId);
      expect(collId).not.toBe(posId);
    });

    it('each outcome slot in a condition maps to a unique position', () => {
      const condId = getConditionId(oracle1, questionId1, 3);

      // Three outcomes: index_set 1, 2, 4
      const col0 = getCollectionId(0n, condId, 1n);
      const col1 = getCollectionId(0n, condId, 2n);
      const col2 = getCollectionId(0n, condId, 4n);

      const pos0 = getPositionId(collateral1, col0);
      const pos1 = getPositionId(collateral1, col1);
      const pos2 = getPositionId(collateral1, col2);

      // All positions should be unique
      const positions = new Set([pos0, pos1, pos2]);
      expect(positions.size).toBe(3);
    });
  });

  describe('Determinism', () => {
    it('repeated computation of condition_id yields identical results', () => {
      const results = Array.from({ length: 10 }, () =>
        getConditionId(oracle1, questionId1, outcomeCount2),
      );
      const unique = new Set(results);
      expect(unique.size).toBe(1);
    });

    it('repeated computation of collection_id yields identical results', () => {
      const condId = getConditionId(oracle1, questionId1, outcomeCount2);
      const results = Array.from({ length: 10 }, () =>
        getCollectionId(0n, condId, 1n),
      );
      const unique = new Set(results);
      expect(unique.size).toBe(1);
    });

    it('repeated computation of position_id yields identical results', () => {
      const condId = getConditionId(oracle1, questionId1, outcomeCount2);
      const colId = getCollectionId(0n, condId, 1n);
      const results = Array.from({ length: 10 }, () =>
        getPositionId(collateral1, colId),
      );
      const unique = new Set(results);
      expect(unique.size).toBe(1);
    });
  });
});
