/**
 * Tests for Position Splitting (Requirements 3 & 4).
 *
 * Validates:
 * - Full-set split from collateral (2-outcome, 3-outcome, coarse 4-outcome)
 * - Partial-set split (subset of outcomes)
 * - Deep split with non-null parent_collection_id
 *
 * Split arrives via transfer_notification (op 0x7362d09c) from the contract's
 * Jetton wallet. The forward_payload contains the split_position parameters.
 *
 * These tests are written BEFORE the implementation (TDD).
 * They will fail until task 6.3/6.4 implements the transfer_notification handler.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  Blockchain,
  SandboxContract,
  TreasuryContract,
  BlockchainTransaction,
} from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import type { Message as TonMessage } from '@ton/core';
import {
  ConditionRegistry,
  RegistryErrors,
  buildSplitPositionPayload,
} from '../../wrappers-ts/ConditionRegistry.gen';

// ————————————————————————————————————————————
//   Helpers
// ————————————————————————————————————————————

/** Load compiled contract code from build output */
function loadContractCode(): Cell {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const artifact = require('../../build/ConditionRegistry.json');
  return Cell.fromBase64(artifact.code_boc64);
}

/** Convert an Address to the bigint format used by sandbox transaction.address */
function addressToBigint(address: Address): bigint {
  return BigInt('0x' + address.hash.toString('hex'));
}

/**
 * Extract the exit code from the transaction targeting the registry contract.
 * Finds the last transaction sent TO the registry address and reads the VM exit code.
 */
function getRegistryExitCode(
  transactions: BlockchainTransaction[],
  registryAddress: Address,
): number {
  const registryHash = addressToBigint(registryAddress);

  for (let i = transactions.length - 1; i >= 0; i--) {
    const tx = transactions[i];
    if (tx.address === registryHash && tx.description.type === 'generic') {
      const computePhase = tx.description.computePhase;
      if (computePhase.type === 'vm') {
        return computePhase.exitCode;
      }
    }
  }
  throw new Error('No VM transaction found on registry');
}

/**
 * Compute the condition_id locally using the same derivation logic as the contract:
 * condition_id = hash(oracle_address || question_id || outcome_slot_count)
 */
function computeConditionId(
  oracleAddress: Address,
  questionId: bigint,
  outcomeSlotCount: number,
): bigint {
  const cell = beginCell()
    .storeAddress(oracleAddress)
    .storeUint(questionId, 256)
    .storeUint(outcomeSlotCount, 8)
    .endCell();
  return BigInt('0x' + cell.hash().toString('hex'));
}

/**
 * Compute a collection_id locally using the same derivation as the contract:
 * collection_id = hash(parent_collection_id || condition_id || index_set)
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
 * Build a transfer_notification message body as if sent from the registry's Jetton wallet.
 * This simulates a Jetton transfer arriving at the registry.
 *
 * transfer_notification layout:
 *   op: uint32 = 0x7362d09c
 *   query_id: uint64
 *   amount: coins (amount of Jettons transferred)
 *   sender: MsgAddress (the original sender/trader)
 *   forward_payload: Cell ref (the split_position payload)
 */
function buildTransferNotification(params: {
  amount: bigint;
  sender: Address;
  forwardPayload: Cell;
}): Cell {
  return beginCell()
    .storeUint(0x7362d09c, 32)  // op::transfer_notification
    .storeUint(0, 64)            // query_id
    .storeCoins(params.amount)   // amount of Jettons transferred
    .storeAddress(params.sender) // sender (the trader)
    .storeRef(params.forwardPayload) // forward_payload as ref
    .endCell();
}

// ————————————————————————————————————————————
//   Tests
// ————————————————————————————————————————————

describe('Position Splitting', () => {
  let blockchain: Blockchain;
  let registry: SandboxContract<ConditionRegistry>;
  let deployer: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let trader: SandboxContract<TreasuryContract>;
  let jettonMaster: SandboxContract<TreasuryContract>;
  let registryJettonWallet: Address;
  let contractCode: Cell;

  const questionId1 = 1n;
  const questionId2 = 2n;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    oracle = await blockchain.treasury('oracle');
    trader = await blockchain.treasury('trader');
    jettonMaster = await blockchain.treasury('jettonMaster');

    contractCode = loadContractCode();

    // Use a deterministic address for the registry's Jetton wallet
    // In production, the registry stores its own Jetton wallet address
    const registryJettonWalletTreasury = await blockchain.treasury('registryJettonWallet');
    registryJettonWallet = registryJettonWalletTreasury.address;

    // Deploy ConditionRegistry with jettonWallet set to our mock wallet address
    const contract = ConditionRegistry.fromStorage(
      { owner: deployer.address, jettonWallet: registryJettonWallet },
      contractCode,
    );

    registry = blockchain.openContract(contract);

    // Deploy the contract by sending an empty message
    await registry.sendDeploy(deployer.getSender(), toNano('0.5'));
  });

  /**
   * Helper: Prepare a condition and return its condition_id.
   */
  async function prepareCondition(
    outcomeSlotCount: number,
    questionId: bigint = questionId1,
  ): Promise<bigint> {
    await registry.sendPrepareCondition(
      deployer.getSender(),
      toNano('0.1'),
      {
        oracle: oracle.address,
        questionId,
        outcomeSlotCount,
      },
    );
    return computeConditionId(oracle.address, questionId, outcomeSlotCount);
  }

  /**
   * Helper: Send a split_position via transfer_notification to the registry.
   * Simulates the Jetton wallet sending the notification after a Jetton transfer.
   *
   * Constructs a proper internal Message and sends it via blockchain.sendMessage().
   */
  async function sendSplitPosition(params: {
    conditionId: bigint;
    partition: bigint[];
    amount: bigint;
    parentCollectionId?: bigint;
    sender?: Address;
    from?: Address;
  }) {
    const splitPayload = buildSplitPositionPayload({
      collateralToken: jettonMaster.address,
      parentCollectionId: params.parentCollectionId ?? 0n,
      conditionId: params.conditionId,
      partition: params.partition,
    });

    const transferNotification = buildTransferNotification({
      amount: params.amount,
      sender: params.sender ?? trader.address,
      forwardPayload: splitPayload,
    });

    // Construct a proper internal Message object (not MessageRelaxed).
    // This is what blockchain.sendMessage() expects when given an object.
    const msg: TonMessage = {
      info: {
        type: 'internal',
        ihrDisabled: true,
        bounce: true,
        bounced: false,
        src: params.from ?? registryJettonWallet,
        dest: registry.address,
        value: { coins: toNano('0.1') },
        ihrFee: 0n,
        forwardFee: 0n,
        createdLt: 0n,
        createdAt: 0,
      },
      body: transferNotification,
    };

    const result = await blockchain.sendMessage(msg);

    return result;
  }

  // ─── Full-Set Split from Collateral ──────────────────────────────────────

  describe('full-set split from collateral', () => {
    it('should successfully split with partition [1, 2] on a 2-outcome condition', async () => {
      // Prepare a 2-outcome condition
      // Full index set for 2 outcomes = 2^2 - 1 = 3
      // Partition [1, 2] covers all outcomes: 1 | 2 = 3 = full set
      const conditionId = await prepareCondition(2);

      const result = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(0);
    });

    it('should successfully split with partition [1, 2, 4] on a 3-outcome condition', async () => {
      // Prepare a 3-outcome condition
      // Full index set for 3 outcomes = 2^3 - 1 = 7
      // Partition [1, 2, 4] covers all outcomes: 1 | 2 | 4 = 7 = full set
      const conditionId = await prepareCondition(3);

      const result = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n, 4n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(0);
    });

    it('should successfully split with coarse partition [3, 12] on a 4-outcome condition', async () => {
      // Prepare a 4-outcome condition
      // Full index set for 4 outcomes = 2^4 - 1 = 15
      // Partition [3, 12]:
      //   3  = 0b0011 (outcomes 0 and 1)
      //   12 = 0b1100 (outcomes 2 and 3)
      //   3 | 12 = 15 = full set
      //   3 & 12 = 0 (disjoint)
      const conditionId = await prepareCondition(4);

      const result = await sendSplitPosition({
        conditionId,
        partition: [3n, 12n],
        amount: 50n,
      });

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(0);
    });
  });

  // ─── Partial-Set Split ───────────────────────────────────────────────────

  describe('partial-set split', () => {
    it('should successfully split a partial partition [1, 2] on a 3-outcome condition', async () => {
      // Prepare a 3-outcome condition
      // Full index set for 3 outcomes = 2^3 - 1 = 7
      // Partition [1, 2]:
      //   1 = 0b001 (outcome 0)
      //   2 = 0b010 (outcome 1)
      //   1 | 2 = 3 ≠ 7 → partial split (not full coverage)
      //   1 & 2 = 0 (disjoint)
      //
      // For a partial split, the contract should:
      // - Burn the union position (collection derived from parent=0, condition, indexSet=3)
      // - Mint sub-positions for each index set in the partition
      //
      // First, we need the trader to HAVE the union position.
      // Do a full-set split first to give the trader positions [1, 2, 4]:
      const conditionId = await prepareCondition(3);

      // First split: full-set [1, 2, 4] to get all individual positions
      const fullSplitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n, 4n],
        amount: 100n,
      });

      const fullSplitExitCode = getRegistryExitCode(fullSplitResult.transactions, registry.address);
      expect(fullSplitExitCode).toBe(0);

      // Now do a partial split on a DIFFERENT condition where trader has a union position.
      // Actually, for a partial split the user needs to hold the "union" position.
      // The union of [1, 2] = 3, so trader needs position with indexSet=3.
      //
      // Let's prepare a second condition and do a coarse full-set split with [3, 4]:
      const conditionId2 = await prepareCondition(3, questionId2);

      // Full-set split on condition2 with partition [3, 4]:
      //   3 = 0b011 (outcomes 0,1)
      //   4 = 0b100 (outcome 2)
      //   3 | 4 = 7 = full set
      const fullSplitResult2 = await sendSplitPosition({
        conditionId: conditionId2,
        partition: [3n, 4n],
        amount: 100n,
      });

      const fullSplitExitCode2 = getRegistryExitCode(fullSplitResult2.transactions, registry.address);
      expect(fullSplitExitCode2).toBe(0);

      // Now trader has position with indexSet=3 on condition2.
      // Do a partial split: split the indexSet=3 position into [1, 2]
      // This is a "deep split" in terms of the same condition — splitting a coarse
      // position into finer granularity.
      // parent_collection_id = 0 (from collateral)
      // The partition [1, 2] covers indexSet 3 (1|2=3), so this is valid.
      const partialSplitResult = await sendSplitPosition({
        conditionId: conditionId2,
        partition: [1n, 2n],
        amount: 100n,
      });

      const partialExitCode = getRegistryExitCode(partialSplitResult.transactions, registry.address);
      expect(partialExitCode).toBe(0);
    });
  });

  // ─── Rejection: Condition Not Prepared ──────────────────────────────────

  describe('rejection: condition not prepared', () => {
    it('should reject split with error 202 when condition_id does not exist', async () => {
      // Use a completely fabricated condition_id that was never prepared
      const fakeConditionId = BigInt('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

      const result = await sendSplitPosition({
        conditionId: fakeConditionId,
        partition: [1n, 2n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.ConditionNotFound); // 202
    });
  });

  // ─── Rejection: Invalid Partition ─────────────────────────────────────────

  describe('rejection: invalid partition', () => {
    it('should reject partition with only 1 index set with error 206', async () => {
      // Prepare a 2-outcome condition (full set = 3)
      const conditionId = await prepareCondition(2);

      // Partition with only 1 index set [3] — needs at least 2
      const result = await sendSplitPosition({
        conditionId,
        partition: [3n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidPartition); // 206
    });

    it('should reject partition with a zero index set with error 206', async () => {
      // Prepare a 2-outcome condition (full set = 3)
      const conditionId = await prepareCondition(2);

      // Partition [0, 1] — zero index set is invalid
      const result = await sendSplitPosition({
        conditionId,
        partition: [0n, 1n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidPartition); // 206
    });

    it('should reject partition with index set >= full set with error 206', async () => {
      // Prepare a 3-outcome condition (full set = 2^3 - 1 = 7)
      const conditionId = await prepareCondition(3);

      // Partition [7, 1] — index_set 7 equals the full set, which is invalid
      const result = await sendSplitPosition({
        conditionId,
        partition: [7n, 1n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidPartition); // 206
    });

    it('should reject partition with overlapping index sets with error 206', async () => {
      // Prepare a 3-outcome condition (full set = 7)
      const conditionId = await prepareCondition(3);

      // Partition [3, 5]:
      //   3 = 0b011 (outcomes 0, 1)
      //   5 = 0b101 (outcomes 0, 2)
      //   3 & 5 = 0b001 ≠ 0 → overlapping at bit 0
      const result = await sendSplitPosition({
        conditionId,
        partition: [3n, 5n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidPartition); // 206
    });
  });

  // ─── Rejection: Insufficient Balance ──────────────────────────────────────

  describe('rejection: insufficient balance', () => {
    it('should reject partial split with error 207 when user has no union position balance', async () => {
      // Prepare a 3-outcome condition (full set = 7)
      const conditionId = await prepareCondition(3);

      // Attempt a partial split [1, 2] (union = 3, which is NOT the full set 7)
      // The trader has NO prior balance for the union position (indexSet=3),
      // so this should fail with InsufficientBalance.
      //
      // For a partial split (where the union of partition != full set),
      // the contract must check that the user holds enough of the parent/union position.
      // Since no prior split was done, the user has 0 balance → error 207.
      const result = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InsufficientBalance); // 207
    });
  });

  // ─── Deep Split (Non-Null Parent) ────────────────────────────────────────

  describe('deep split (non-null parent)', () => {
    it('should successfully split with non-null parent_collection_id', async () => {
      // Step 1: Prepare condition A (2-outcome)
      const conditionIdA = await prepareCondition(2, questionId1);

      // Step 2: Full-set split on condition A with partition [1, 2]
      // This gives trader positions:
      //   - positionId for collectionId = hash(0, conditionA, 1) → "outcome 0 of A"
      //   - positionId for collectionId = hash(0, conditionA, 2) → "outcome 1 of A"
      const splitResultA = await sendSplitPosition({
        conditionId: conditionIdA,
        partition: [1n, 2n],
        amount: 100n,
      });

      const exitCodeA = getRegistryExitCode(splitResultA.transactions, registry.address);
      expect(exitCodeA).toBe(0);

      // Step 3: Prepare condition B (2-outcome)
      const conditionIdB = await prepareCondition(2, questionId2);

      // Step 4: Deep split — split the "outcome 0 of A" position further by condition B
      // parent_collection_id = hash(0, conditionA, 1) — the collection from step 2
      // This creates deeper positions:
      //   collectionId = hash(parent_collection_id, conditionB, 1) → "A=0 AND B=0"
      //   collectionId = hash(parent_collection_id, conditionB, 2) → "A=0 AND B=1"
      const parentCollectionId = computeCollectionId(0n, conditionIdA, 1n);

      const deepSplitResult = await sendSplitPosition({
        conditionId: conditionIdB,
        partition: [1n, 2n],
        amount: 100n,
        parentCollectionId,
      });

      const exitCodeDeep = getRegistryExitCode(deepSplitResult.transactions, registry.address);
      expect(exitCodeDeep).toBe(0);
    });
  });
});
