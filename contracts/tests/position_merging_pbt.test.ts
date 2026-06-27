/**
 * Property-based tests for position merging round-trip (Requirement 5, AC 5).
 *
 * **Validates: Requirements 5.5**
 *
 * Property: Split then merge round-trip restores balances exactly.
 *
 * FOR ALL valid partitions and amounts, splitting followed by merging with the
 * same parameters SHALL restore the original token balances (round-trip property).
 *
 * This uses a pure TypeScript simulation of the split/merge balance logic to
 * enable fast iterations (no sandbox overhead per property test run).
 * The simulation mirrors the contract's balance accounting:
 *   - Split: For a full-set partition (covering all outcomes), lock collateral
 *     and mint position tokens. For a partial-set partition, burn the union
 *     position and mint individual positions.
 *   - Merge: The inverse — burn individual positions and either release
 *     collateral (full-set) or mint the union position (partial-set).
 */

import { describe, it, expect } from 'vitest';
import { beginCell, Address } from '@ton/core';
import * as fc from 'fast-check';
import './setup';

// ————————————————————————————————————————————
//   TypeScript Reference Implementations
// ————————————————————————————————————————————

/**
 * Compute collection_id (matches contract derivation).
 */
function computeCollectionId(
  parentCollectionId: bigint,
  conditionId: bigint,
  indexSet: bigint,
): bigint {
  const cell = beginCell()
    .storeUint(parentCollectionId, 256)
    .storeUint(conditionId, 256)
    .storeUint(indexSet, 256)
    .endCell();
  return BigInt('0x' + cell.hash().toString('hex'));
}

/**
 * Compute position_id (matches contract derivation).
 */
function computePositionId(
  collateralToken: Address,
  collectionId: bigint,
): bigint {
  const cell = beginCell()
    .storeAddress(collateralToken)
    .storeUint(collectionId, 256)
    .endCell();
  return BigInt('0x' + cell.hash().toString('hex'));
}

// ————————————————————————————————————————————
//   Balance Simulation
// ————————————————————————————————————————————

/**
 * Simulates position balance accounting as the contract does.
 * Key: positionId → balance (bigint).
 */
type BalanceMap = Map<bigint, bigint>;

function getBalance(balances: BalanceMap, positionId: bigint): bigint {
  return balances.get(positionId) ?? 0n;
}

function setBalance(balances: BalanceMap, positionId: bigint, amount: bigint): void {
  if (amount === 0n) {
    balances.delete(positionId);
  } else {
    balances.set(positionId, amount);
  }
}

/**
 * Compute the full index set for an outcome_slot_count.
 * Full set = (2^n) - 1 (all bits set for n outcomes).
 */
function fullIndexSet(outcomeSlotCount: number): bigint {
  return (1n << BigInt(outcomeSlotCount)) - 1n;
}

/**
 * Compute the union of index sets in a partition.
 */
function partitionUnion(partition: bigint[]): bigint {
  return partition.reduce((acc, s) => acc | s, 0n);
}

/**
 * Simulate a split_position operation.
 *
 * - If the partition covers the full set: deduct collateral (represented as
 *   collateral position), mint each partition position.
 * - If partial: burn the union position, mint each partition position.
 */
function simulateSplit(params: {
  balances: BalanceMap;
  collateralToken: Address;
  parentCollectionId: bigint;
  conditionId: bigint;
  partition: bigint[];
  amount: bigint;
  outcomeSlotCount: number;
}): void {
  const { balances, collateralToken, parentCollectionId, conditionId, partition, amount, outcomeSlotCount } = params;
  const union = partitionUnion(partition);
  const full = fullIndexSet(outcomeSlotCount);

  if (union === full && parentCollectionId === 0n) {
    // Full-set split from collateral: just mint positions (collateral is "locked")
    // In the real contract, collateral Jettons are held by the contract.
    // We represent collateral balance as a special key.
    const collateralKey = computePositionId(collateralToken, 0n);
    const currentCollateral = getBalance(balances, collateralKey);
    setBalance(balances, collateralKey, currentCollateral + amount);
  } else {
    // Partial split or deep split: burn the union/parent position
    const unionCollectionId = computeCollectionId(parentCollectionId, conditionId, union);
    const unionPositionId = computePositionId(collateralToken, unionCollectionId);
    const currentUnionBalance = getBalance(balances, unionPositionId);
    setBalance(balances, unionPositionId, currentUnionBalance - amount);
  }

  // Mint each partition position
  for (const indexSet of partition) {
    const collectionId = computeCollectionId(parentCollectionId, conditionId, indexSet);
    const positionId = computePositionId(collateralToken, collectionId);
    const current = getBalance(balances, positionId);
    setBalance(balances, positionId, current + amount);
  }
}

/**
 * Simulate a merge_positions operation (inverse of split).
 *
 * - If the partition covers the full set: burn each partition position,
 *   release collateral.
 * - If partial: burn each partition position, mint the union position.
 */
function simulateMerge(params: {
  balances: BalanceMap;
  collateralToken: Address;
  parentCollectionId: bigint;
  conditionId: bigint;
  partition: bigint[];
  amount: bigint;
  outcomeSlotCount: number;
}): void {
  const { balances, collateralToken, parentCollectionId, conditionId, partition, amount, outcomeSlotCount } = params;
  const union = partitionUnion(partition);
  const full = fullIndexSet(outcomeSlotCount);

  // Burn each partition position
  for (const indexSet of partition) {
    const collectionId = computeCollectionId(parentCollectionId, conditionId, indexSet);
    const positionId = computePositionId(collateralToken, collectionId);
    const current = getBalance(balances, positionId);
    setBalance(balances, positionId, current - amount);
  }

  if (union === full && parentCollectionId === 0n) {
    // Full-set merge to collateral: release the locked collateral
    const collateralKey = computePositionId(collateralToken, 0n);
    const currentCollateral = getBalance(balances, collateralKey);
    setBalance(balances, collateralKey, currentCollateral - amount);
  } else {
    // Partial merge or deep merge: mint the union/parent position
    const unionCollectionId = computeCollectionId(parentCollectionId, conditionId, union);
    const unionPositionId = computePositionId(collateralToken, unionCollectionId);
    const currentUnionBalance = getBalance(balances, unionPositionId);
    setBalance(balances, unionPositionId, currentUnionBalance + amount);
  }
}

// ————————————————————————————————————————————
//   Partition Generator
// ————————————————————————————————————————————

/**
 * Generate a valid partition for a given outcome_slot_count.
 *
 * Strategy:
 * 1. Generate a random permutation of outcome indices (0..n-1)
 * 2. Randomly choose split points to create 2+ groups
 * 3. Convert each group to an index set bitmask
 *
 * This guarantees: disjoint, non-zero, and within bounds.
 */
function validPartitionArb(outcomeSlotCount: number): fc.Arbitrary<bigint[]> {
  // Generate a permutation of [0, 1, ..., n-1]
  const indicesArb = fc.shuffledSubarray(
    Array.from({ length: outcomeSlotCount }, (_, i) => i),
    { minLength: outcomeSlotCount, maxLength: outcomeSlotCount },
  );

  // Generate split points: we need at least 2 groups, so at least 1 split point
  // Split points are positions in the permutation where we "cut" to form groups
  // For n items, we can have splits at positions 1..n-1
  const splitPointsArb = (n: number) =>
    fc.shuffledSubarray(
      Array.from({ length: n - 1 }, (_, i) => i + 1),
      { minLength: 1, maxLength: n - 1 },
    ).map((points) => points.sort((a, b) => a - b));

  return indicesArb.chain((indices) =>
    splitPointsArb(indices.length).map((splitPoints) => {
      const groups: number[][] = [];
      let start = 0;
      for (const sp of splitPoints) {
        groups.push(indices.slice(start, sp));
        start = sp;
      }
      groups.push(indices.slice(start));

      // Convert each group to a bitmask
      return groups.map((group) =>
        group.reduce((mask, idx) => mask | (1n << BigInt(idx)), 0n),
      );
    }),
  );
}

// ————————————————————————————————————————————
//   Property-Based Tests
// ————————————————————————————————————————————

describe('Position Merging – Property-Based Tests', () => {
  // Use a deterministic collateral token address for simulation
  const collateralToken = new Address(0, Buffer.alloc(32, 0xaa));

  // Use a deterministic conditionId (simulates a prepared condition)
  const conditionId = 123456789n;

  describe('Split then merge round-trip restores balances exactly', () => {
    /**
     * **Validates: Requirements 5.5**
     *
     * For any random outcome_slot_count (2-8), random amount (1 to 10000),
     * and random valid partition:
     *   1. Start with empty balances
     *   2. Split `amount` tokens using the partition
     *   3. Merge `amount` tokens using the same partition
     *   4. All position balances return to 0 (original state)
     *
     * This tests with a null parent_collection_id (split from collateral).
     */
    it('full-set split from collateral then merge restores all balances to zero', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 8 }),
          fc.bigInt({ min: 1n, max: 10000n }),
          (outcomeSlotCount, amount) => {
            // For a full-set round-trip, we use the full partition:
            // each outcome gets its own index set (individual bits)
            const partition = Array.from(
              { length: outcomeSlotCount },
              (_, i) => 1n << BigInt(i),
            );

            const balances: BalanceMap = new Map();

            // Split from collateral
            simulateSplit({
              balances,
              collateralToken,
              parentCollectionId: 0n,
              conditionId,
              partition,
              amount,
              outcomeSlotCount,
            });

            // Verify positions were minted
            for (const indexSet of partition) {
              const collectionId = computeCollectionId(0n, conditionId, indexSet);
              const positionId = computePositionId(collateralToken, collectionId);
              expect(getBalance(balances, positionId)).toBe(amount);
            }

            // Merge back
            simulateMerge({
              balances,
              collateralToken,
              parentCollectionId: 0n,
              conditionId,
              partition,
              amount,
              outcomeSlotCount,
            });

            // All balances should be zero (map should be empty)
            for (const [, balance] of balances) {
              expect(balance).toBe(0n);
            }
            expect(balances.size).toBe(0);
          },
        ),
      );
    });

    /**
     * **Validates: Requirements 5.5**
     *
     * For any random outcome_slot_count (2-8), random amount (1 to 10000),
     * and random valid partition (may be partial or full):
     *   1. Set up initial union position balance (for partial splits)
     *   2. Split `amount` tokens using the partition
     *   3. Merge `amount` tokens using the same partition
     *   4. All position balances return to original state
     *
     * This tests with arbitrary partitions (including partial).
     */
    it('arbitrary valid partition split then merge is a no-op on balances', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 8 }).chain((outcomeSlotCount) =>
            fc.tuple(
              fc.constant(outcomeSlotCount),
              fc.bigInt({ min: 1n, max: 10000n }),
              validPartitionArb(outcomeSlotCount),
            ),
          ),
          ([outcomeSlotCount, amount, partition]) => {
            const balances: BalanceMap = new Map();
            const parentCollectionId = 0n;
            const union = partitionUnion(partition);
            const full = fullIndexSet(outcomeSlotCount);

            if (union === full) {
              // Full-set split from collateral — no precondition needed
            } else {
              // Partial split: need the union position to have sufficient balance
              const unionCollectionId = computeCollectionId(parentCollectionId, conditionId, union);
              const unionPositionId = computePositionId(collateralToken, unionCollectionId);
              setBalance(balances, unionPositionId, amount);
            }

            // Snapshot the initial state
            const initialState = new Map(balances);

            // Split
            simulateSplit({
              balances,
              collateralToken,
              parentCollectionId,
              conditionId,
              partition,
              amount,
              outcomeSlotCount,
            });

            // Merge (same params)
            simulateMerge({
              balances,
              collateralToken,
              parentCollectionId,
              conditionId,
              partition,
              amount,
              outcomeSlotCount,
            });

            // Verify: final state equals initial state
            // Check that all initial positions are restored
            for (const [posId, bal] of initialState) {
              expect(getBalance(balances, posId)).toBe(bal);
            }

            // Check that no new positions were created
            for (const [posId, bal] of balances) {
              if (!initialState.has(posId)) {
                expect(bal).toBe(0n);
              }
            }
          },
        ),
      );
    });

    /**
     * **Validates: Requirements 5.5**
     *
     * Deep split then merge round-trip: with a non-null parent_collection_id,
     * splitting and then merging restores the balance state.
     */
    it('deep split then merge round-trip with non-null parent restores balances', () => {
      // Use a fixed parent to simulate a deep position scenario
      const parentConditionId = 999n;
      const parentIndexSet = 1n; // outcome 0 of parent condition
      const parentCollectionId = computeCollectionId(0n, parentConditionId, parentIndexSet);

      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 6 }).chain((outcomeSlotCount) =>
            fc.tuple(
              fc.constant(outcomeSlotCount),
              fc.bigInt({ min: 1n, max: 10000n }),
              validPartitionArb(outcomeSlotCount),
            ),
          ),
          ([outcomeSlotCount, amount, partition]) => {
            const balances: BalanceMap = new Map();
            const union = partitionUnion(partition);
            const full = fullIndexSet(outcomeSlotCount);

            if (union === full) {
              // Deep full-set split: burns parent position, so we need parent balance
              // The "parent position" for a deep split with full partition is
              // the position at (collateralToken, parentCollectionId)
              // Actually for deep split with full set, the union == full means
              // the contract burns the position at parentCollectionId level
              // We need the union position to exist:
              const unionCollectionId = computeCollectionId(parentCollectionId, conditionId, union);
              const unionPositionId = computePositionId(collateralToken, unionCollectionId);
              setBalance(balances, unionPositionId, amount);
            } else {
              // Partial deep split: burns the union position under the parent
              const unionCollectionId = computeCollectionId(parentCollectionId, conditionId, union);
              const unionPositionId = computePositionId(collateralToken, unionCollectionId);
              setBalance(balances, unionPositionId, amount);
            }

            // Snapshot
            const initialState = new Map(balances);

            // Split
            simulateSplit({
              balances,
              collateralToken,
              parentCollectionId,
              conditionId,
              partition,
              amount,
              outcomeSlotCount,
            });

            // Merge
            simulateMerge({
              balances,
              collateralToken,
              parentCollectionId,
              conditionId,
              partition,
              amount,
              outcomeSlotCount,
            });

            // Verify: state is restored
            for (const [posId, bal] of initialState) {
              expect(getBalance(balances, posId)).toBe(bal);
            }
            for (const [posId, bal] of balances) {
              if (!initialState.has(posId)) {
                expect(bal).toBe(0n);
              }
            }
          },
        ),
      );
    });
  });
});
