/**
 * Tests for Position Merging (Requirement 5).
 *
 * Validates:
 * - Full-set merge to collateral (2-outcome, 3-outcome)
 * - Partial-set merge (subset of outcomes → union position)
 * - Deep merge with non-null parent_collection_id
 *
 * Merge is sent as a direct internal message from the trader (op 0x04).
 * Unlike split, merge does NOT arrive via transfer_notification.
 *
 * These tests are written BEFORE the implementation (TDD).
 * They will fail until task 7.4 implements the merge handler.
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

describe('Position Merging', () => {
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
    const registryJettonWalletTreasury = await blockchain.treasury('registryJettonWallet');
    registryJettonWallet = registryJettonWalletTreasury.address;

    // Deploy ConditionRegistry with jettonWallet set to our mock wallet address
    const contract = ConditionRegistry.fromStorage(
      { owner: deployer.address, jettonWallet: registryJettonWallet, collateralToken: jettonMaster.address },
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

    return await blockchain.sendMessage(msg);
  }

  /**
   * Helper: Send a merge_positions message directly from the trader.
   * Merge is a direct internal message (not via transfer_notification).
   */
  async function sendMergePositions(params: {
    conditionId: bigint;
    partition: bigint[];
    amount: bigint;
    parentCollectionId?: bigint;
    sender?: SandboxContract<TreasuryContract>;
  }) {
    const senderContract = params.sender ?? trader;

    const result = await registry.sendMergePositions(
      senderContract.getSender(),
      toNano('0.1'),
      {
        collateralToken: jettonMaster.address,
        parentCollectionId: params.parentCollectionId ?? 0n,
        conditionId: params.conditionId,
        partition: params.partition,
        amount: params.amount,
      },
    );

    return result;
  }

  // ─── Full-Set Merge to Collateral ─────────────────────────────────────────

  describe('full-set merge to collateral', () => {
    it('should successfully merge [1, 2] on a 2-outcome condition back to collateral', async () => {
      // Step 1: Prepare a 2-outcome condition
      const conditionId = await prepareCondition(2);

      // Step 2: Split 100 tokens into positions [1, 2]
      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });
      const splitExitCode = getRegistryExitCode(splitResult.transactions, registry.address);
      expect(splitExitCode).toBe(0);

      // Step 3: Merge all positions [1, 2] back — full set merge to collateral
      // Full index set for 2 outcomes = 3, partition [1, 2] covers all: 1|2 = 3
      const mergeResult = await sendMergePositions({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });

      const mergeExitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(mergeExitCode).toBe(0);
    });

    it('should successfully merge [1, 2, 4] on a 3-outcome condition back to collateral', async () => {
      // Step 1: Prepare a 3-outcome condition
      const conditionId = await prepareCondition(3);

      // Step 2: Split 50 tokens into positions [1, 2, 4]
      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n, 4n],
        amount: 50n,
      });
      const splitExitCode = getRegistryExitCode(splitResult.transactions, registry.address);
      expect(splitExitCode).toBe(0);

      // Step 3: Merge all positions [1, 2, 4] back — full set merge to collateral
      // Full index set for 3 outcomes = 7, partition [1, 2, 4] covers all: 1|2|4 = 7
      const mergeResult = await sendMergePositions({
        conditionId,
        partition: [1n, 2n, 4n],
        amount: 50n,
      });

      const mergeExitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(mergeExitCode).toBe(0);
    });
  });

  // ─── Partial-Set Merge ────────────────────────────────────────────────────

  describe('partial-set merge', () => {
    it('should merge [1, 2] into union position (indexSet=3) on a 3-outcome condition', async () => {
      // Step 1: Prepare a 3-outcome condition
      const conditionId = await prepareCondition(3);

      // Step 2: Split 100 tokens into individual positions [1, 2, 4]
      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n, 4n],
        amount: 100n,
      });
      const splitExitCode = getRegistryExitCode(splitResult.transactions, registry.address);
      expect(splitExitCode).toBe(0);

      // Step 3: Merge positions [1, 2] — partial merge
      // This should burn positions with indexSet=1 and indexSet=2,
      // and mint a position with indexSet=3 (the union: 1|2=3)
      // Since 3 != 7 (full set), this is a partial merge
      const mergeResult = await sendMergePositions({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });

      const mergeExitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(mergeExitCode).toBe(0);
    });
  });

  // ─── Rejection: Insufficient Balance ──────────────────────────────────────

  describe('rejection: insufficient balance', () => {
    it('should reject merge with error 207 when user has no position balance', async () => {
      // Prepare a 2-outcome condition
      const conditionId = await prepareCondition(2);

      // Attempt to merge [1, 2] without ever having split — no balances exist
      const mergeResult = await sendMergePositions({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InsufficientBalance); // 207
    });

    it('should reject merge with error 207 when amount exceeds position balance', async () => {
      // Prepare a 2-outcome condition
      const conditionId = await prepareCondition(2);

      // Split only 50 tokens into [1, 2]
      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 50n,
      });
      const splitExitCode = getRegistryExitCode(splitResult.transactions, registry.address);
      expect(splitExitCode).toBe(0);

      // Attempt to merge 100 tokens — but we only have 50 in each position
      const mergeResult = await sendMergePositions({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InsufficientBalance); // 207
    });
  });

  // ─── Rejection: Invalid Partition ─────────────────────────────────────────

  describe('rejection: invalid partition (merge)', () => {
    it('should reject partition with only 1 index set with error 206', async () => {
      // Prepare a 2-outcome condition (full set = 3)
      const conditionId = await prepareCondition(2);

      // Partition with only 1 index set [3] — needs at least 2
      const mergeResult = await sendMergePositions({
        conditionId,
        partition: [3n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidPartition); // 206
    });

    it('should reject partition with a zero index set with error 206', async () => {
      // Prepare a 2-outcome condition (full set = 3)
      const conditionId = await prepareCondition(2);

      // Partition [0, 1] — zero index set is invalid
      const mergeResult = await sendMergePositions({
        conditionId,
        partition: [0n, 1n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidPartition); // 206
    });

    it('should reject partition with overlapping index sets with error 206', async () => {
      // Prepare a 3-outcome condition (full set = 7)
      const conditionId = await prepareCondition(3);

      // Partition [3, 5]:
      //   3 = 0b011 (outcomes 0, 1)
      //   5 = 0b101 (outcomes 0, 2)
      //   3 & 5 = 0b001 ≠ 0 → overlapping at bit 0
      const mergeResult = await sendMergePositions({
        conditionId,
        partition: [3n, 5n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidPartition); // 206
    });

    it('should reject partition with index set >= full set with error 206', async () => {
      // Prepare a 3-outcome condition (full set = 2^3 - 1 = 7)
      const conditionId = await prepareCondition(3);

      // Partition [7, 1] — index_set 7 equals the full set, which is invalid
      const mergeResult = await sendMergePositions({
        conditionId,
        partition: [7n, 1n],
        amount: 100n,
      });

      const exitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidPartition); // 206
    });
  });

  // ─── Deep Merge ───────────────────────────────────────────────────────────

  describe('deep merge (non-null parent)', () => {
    it('should merge deep positions back to restore the parent position', async () => {
      // Step 1: Prepare condition A (2-outcome)
      const conditionIdA = await prepareCondition(2, questionId1);

      // Step 2: Full-set split on condition A with partition [1, 2]
      // This gives trader positions with collectionIds:
      //   hash(0, conditionA, 1) and hash(0, conditionA, 2)
      const splitResultA = await sendSplitPosition({
        conditionId: conditionIdA,
        partition: [1n, 2n],
        amount: 100n,
      });
      const exitCodeA = getRegistryExitCode(splitResultA.transactions, registry.address);
      expect(exitCodeA).toBe(0);

      // Step 3: Prepare condition B (2-outcome)
      const conditionIdB = await prepareCondition(2, questionId2);

      // Step 4: Deep split — split "outcome 0 of A" further by condition B
      // parent_collection_id = hash(0, conditionA, 1)
      const parentCollectionId = computeCollectionId(0n, conditionIdA, 1n);

      const deepSplitResult = await sendSplitPosition({
        conditionId: conditionIdB,
        partition: [1n, 2n],
        amount: 100n,
        parentCollectionId,
      });
      const exitCodeDeep = getRegistryExitCode(deepSplitResult.transactions, registry.address);
      expect(exitCodeDeep).toBe(0);

      // Step 5: Deep merge — merge the deep positions [1, 2] on condition B
      // with parent_collection_id = hash(0, conditionA, 1)
      // This should burn the deep positions and restore the parent position
      const mergeResult = await sendMergePositions({
        conditionId: conditionIdB,
        partition: [1n, 2n],
        amount: 100n,
        parentCollectionId,
      });

      const mergeExitCode = getRegistryExitCode(mergeResult.transactions, registry.address);
      expect(mergeExitCode).toBe(0);
    });
  });
});
