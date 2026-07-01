/**
 * Tests for Position Redemption (Requirement 6).
 *
 * Validates:
 * - Successful full redemption (winner gets full collateral back)
 * - Partial payout (multi-outcome with weighted resolution)
 * - Zero payout (loser's positions burned, no collateral transfer)
 * - Non-null parent (deep redemption mints in parent position)
 * - Rejection: condition not resolved (error 208)
 * - Rejection: invalid index set (error 209)
 *
 * Redemption flow: prepare → split → resolve → redeem
 *
 * These tests are written BEFORE the implementation (TDD).
 * They will fail until task 8.2 implements the redeem_positions handler.
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

describe('Position Redemption', () => {
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
   * Helper: Resolve a condition by reporting payouts from the oracle.
   */
  async function resolveCondition(
    questionId: bigint,
    payouts: bigint[],
  ) {
    return await registry.sendReportPayouts(
      oracle.getSender(),
      toNano('0.1'),
      {
        questionId,
        payouts,
      },
    );
  }

  /**
   * Helper: Send a redeem_positions message from the trader.
   */
  async function sendRedeemPositions(params: {
    conditionId: bigint;
    indexSets: bigint[];
    parentCollectionId?: bigint;
    sender?: SandboxContract<TreasuryContract>;
  }) {
    const senderContract = params.sender ?? trader;

    return await registry.sendRedeemPositions(
      senderContract.getSender(),
      toNano('0.1'),
      {
        collateralToken: jettonMaster.address,
        parentCollectionId: params.parentCollectionId ?? 0n,
        conditionId: params.conditionId,
        indexSets: params.indexSets,
      },
    );
  }

  // ─── Successful Full Redemption ────────────────────────────────────────────

  describe('successful full redemption', () => {
    it('should redeem winning position for full collateral (binary, [1,0], redeem indexSet=1)', async () => {
      // Flow: prepare 2-outcome → split 100 into [1, 2] → resolve [1, 0] → redeem indexSet=1
      // Payout: balance=100 * payout_numerator=1 / denominator=1 = 100
      const conditionId = await prepareCondition(2);

      // Split 100 tokens into positions [1, 2]
      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });
      const splitExitCode = getRegistryExitCode(splitResult.transactions, registry.address);
      expect(splitExitCode).toBe(0);

      // Resolve with payouts [1, 0] → denominator = 1
      const resolveResult = await resolveCondition(questionId1, [1n, 0n]);
      const resolveExitCode = getRegistryExitCode(resolveResult.transactions, registry.address);
      expect(resolveExitCode).toBe(0);

      // Redeem position with indexSet=1 (the winner)
      // payout = 100 * 1 / 1 = 100
      const redeemResult = await sendRedeemPositions({
        conditionId,
        indexSets: [1n],
      });

      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(0);
    });

    it('should redeem both positions in a single call', async () => {
      // Prepare, split, resolve binary [1, 1] (each outcome equally weighted)
      // Denominator = 2
      // Redeem both indexSets [1, 2]:
      //   indexSet=1: payout = 100 * 1 / 2 = 50
      //   indexSet=2: payout = 100 * 1 / 2 = 50
      //   Total = 100
      const conditionId = await prepareCondition(2);

      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });
      expect(getRegistryExitCode(splitResult.transactions, registry.address)).toBe(0);

      await resolveCondition(questionId1, [1n, 1n]);

      const redeemResult = await sendRedeemPositions({
        conditionId,
        indexSets: [1n, 2n],
      });

      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(0);
    });
  });

  // ─── Partial Payout ────────────────────────────────────────────────────────

  describe('partial payout', () => {
    it('should compute partial payout with floor division (3-outcome, [1,2,3], redeem indexSet=1)', async () => {
      // Prepare 3-outcome condition
      // Split 100 into [1, 2, 4]
      // Resolve with payouts [1, 2, 3] → denominator = 6
      // Redeem indexSet=1: payout_numerator for bit 0 = 1
      //   payout = 100 * 1 / 6 = 16 (floor)
      const conditionId = await prepareCondition(3);

      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n, 4n],
        amount: 100n,
      });
      expect(getRegistryExitCode(splitResult.transactions, registry.address)).toBe(0);

      await resolveCondition(questionId1, [1n, 2n, 3n]);

      // Redeem only the first outcome position (indexSet=1, bit 0 set)
      const redeemResult = await sendRedeemPositions({
        conditionId,
        indexSets: [1n],
      });

      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(0);
    });

    it('should compute partial payout for a combined index set (bits 0 and 1)', async () => {
      // Prepare 3-outcome condition
      // Split 100 into [3, 4] (coarse partition: 3=0b011, 4=0b100)
      // Resolve with payouts [1, 2, 3] → denominator = 6
      // Redeem indexSet=3 (bits 0 and 1): payout_numerator = 1 + 2 = 3
      //   payout = 100 * 3 / 6 = 50
      const conditionId = await prepareCondition(3);

      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [3n, 4n],
        amount: 100n,
      });
      expect(getRegistryExitCode(splitResult.transactions, registry.address)).toBe(0);

      await resolveCondition(questionId1, [1n, 2n, 3n]);

      // Redeem combined position (indexSet=3, covers outcomes 0 and 1)
      const redeemResult = await sendRedeemPositions({
        conditionId,
        indexSets: [3n],
      });

      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(0);
    });
  });

  // ─── Zero Payout ───────────────────────────────────────────────────────────

  describe('zero payout', () => {
    it('should burn losing position without transferring collateral (indexSet=2, payouts [1, 0])', async () => {
      // Prepare 2-outcome, split 100, resolve [1, 0]
      // Redeem indexSet=2 (loser): payout_numerator for bit 1 = 0
      //   payout = 100 * 0 / 1 = 0
      // Position should be burned, no collateral transferred
      const conditionId = await prepareCondition(2);

      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });
      expect(getRegistryExitCode(splitResult.transactions, registry.address)).toBe(0);

      await resolveCondition(questionId1, [1n, 0n]);

      // Redeem the loser (indexSet=2)
      const redeemResult = await sendRedeemPositions({
        conditionId,
        indexSets: [2n],
      });

      // Should succeed (exit code 0) — positions burned, zero payout
      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(0);
    });
  });

  // ─── Non-Null Parent (Deep Redemption) ────────────────────────────────────

  describe('non-null parent (deep redemption)', () => {
    it('should mint payout in parent position instead of collateral transfer', async () => {
      // Step 1: Prepare condition A (2-outcome) and condition B (2-outcome)
      const conditionIdA = await prepareCondition(2, questionId1);
      const conditionIdB = await prepareCondition(2, questionId2);

      // Step 2: Split 100 on condition A into positions [1, 2]
      const splitA = await sendSplitPosition({
        conditionId: conditionIdA,
        partition: [1n, 2n],
        amount: 100n,
      });
      expect(getRegistryExitCode(splitA.transactions, registry.address)).toBe(0);

      // Step 3: Deep split — split "outcome 0 of A" further by condition B
      // parent_collection_id = hash(0, conditionA, 1)
      const parentCollectionId = computeCollectionId(0n, conditionIdA, 1n);

      const deepSplit = await sendSplitPosition({
        conditionId: conditionIdB,
        partition: [1n, 2n],
        amount: 100n,
        parentCollectionId,
      });
      expect(getRegistryExitCode(deepSplit.transactions, registry.address)).toBe(0);

      // Step 4: Resolve condition B with [1, 0]
      await resolveCondition(questionId2, [1n, 0n]);

      // Step 5: Redeem deep position with parent_collection_id (non-null parent)
      // This should mint the payout in the parent position rather than sending collateral
      // Payout for indexSet=1: 100 * 1 / 1 = 100 → minted in parent position
      const redeemResult = await sendRedeemPositions({
        conditionId: conditionIdB,
        indexSets: [1n],
        parentCollectionId,
      });

      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(0);
    });
  });

  // ─── Rejection: Condition Not Resolved ─────────────────────────────────────

  describe('rejection: condition not resolved', () => {
    it('should reject redemption with error 208 when condition has not been resolved', async () => {
      // Prepare and split, but do NOT resolve
      const conditionId = await prepareCondition(2);

      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });
      expect(getRegistryExitCode(splitResult.transactions, registry.address)).toBe(0);

      // Attempt to redeem before resolution
      const redeemResult = await sendRedeemPositions({
        conditionId,
        indexSets: [1n],
      });

      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(RegistryErrors.ConditionNotResolved); // 208
    });
  });

  // ─── Rejection: Invalid Index Set ──────────────────────────────────────────

  describe('rejection: invalid index set', () => {
    it('should reject redemption with error 209 when indexSet is 0', async () => {
      // Prepare, split, resolve
      const conditionId = await prepareCondition(2);

      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });
      expect(getRegistryExitCode(splitResult.transactions, registry.address)).toBe(0);

      await resolveCondition(questionId1, [1n, 0n]);

      // Attempt to redeem with indexSet=0 (invalid)
      const redeemResult = await sendRedeemPositions({
        conditionId,
        indexSets: [0n],
      });

      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(RegistryErrors.InvalidIndexSet); // 209
    });

    it('should reject redemption with error 209 when indexSet >= full set', async () => {
      // Prepare 2-outcome (full set = 3), split, resolve
      const conditionId = await prepareCondition(2);

      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      });
      expect(getRegistryExitCode(splitResult.transactions, registry.address)).toBe(0);

      await resolveCondition(questionId1, [1n, 0n]);

      // Attempt to redeem with indexSet=3 (equals full set, invalid)
      const redeemResult = await sendRedeemPositions({
        conditionId,
        indexSets: [3n],
      });

      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(RegistryErrors.InvalidIndexSet); // 209
    });

    it('should reject redemption with error 209 when indexSet exceeds full set', async () => {
      // Prepare 3-outcome (full set = 7), split, resolve
      const conditionId = await prepareCondition(3);

      const splitResult = await sendSplitPosition({
        conditionId,
        partition: [1n, 2n, 4n],
        amount: 100n,
      });
      expect(getRegistryExitCode(splitResult.transactions, registry.address)).toBe(0);

      await resolveCondition(questionId1, [1n, 2n, 3n]);

      // Attempt to redeem with indexSet=8 (exceeds full set of 7, invalid)
      const redeemResult = await sendRedeemPositions({
        conditionId,
        indexSets: [8n],
      });

      const redeemExitCode = getRegistryExitCode(redeemResult.transactions, registry.address);
      expect(redeemExitCode).toBe(RegistryErrors.InvalidIndexSet); // 209
    });
  });
});
