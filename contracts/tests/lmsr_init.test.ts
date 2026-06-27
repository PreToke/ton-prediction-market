/**
 * Tests for LMSR Market Maker Initialization (Requirement 7).
 *
 * Validates:
 * - Successful init: receive Jetton transfer_notification with init_market payload,
 *   store funding, transition to Running stage
 * - Rejection: zero funding amount → error 302 (ZeroFunding)
 * - Rejection: already initialized → error 301 (MarketAlreadyInitialized)
 *
 * The Market Maker receives initialization via transfer_notification (Jetton transfer):
 * 1. Creator sends Jettons to the MM
 * 2. MM receives transfer_notification with init_market forward_payload
 * 3. MM stores the funding, condition config, and initializes position balances
 *
 * These tests are written BEFORE the implementation (TDD).
 * They will fail until task 9.2 implements the transfer_notification handler.
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
  LmsrMarketMaker,
  MarketOpCodes,
  MarketErrors,
  MarketStorage,
  marketStorageToCell,
  STAGE_RUNNING,
} from '../../wrappers-ts/LmsrMarketMaker.gen';

// ————————————————————————————————————————————
//   Helpers
// ————————————————————————————————————————————

/** Load compiled MM contract code from build output */
function loadContractCode(): Cell {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const artifact = require('../../build/LmsrMarketMaker.json');
  return Cell.fromBase64(artifact.code_boc64);
}

/** Convert an Address to the bigint format used by sandbox transaction.address */
function addressToBigint(address: Address): bigint {
  return BigInt('0x' + address.hash.toString('hex'));
}

/**
 * Extract the exit code from the transaction targeting the MM contract.
 * Finds the last transaction sent TO the MM address and reads the VM exit code.
 */
function getMMExitCode(
  transactions: BlockchainTransaction[],
  mmAddress: Address,
): number {
  const mmHash = addressToBigint(mmAddress);

  for (let i = transactions.length - 1; i >= 0; i--) {
    const tx = transactions[i];
    if (tx.address === mmHash && tx.description.type === 'generic') {
      const computePhase = tx.description.computePhase;
      if (computePhase.type === 'vm') {
        return computePhase.exitCode;
      }
    }
  }
  throw new Error('No VM transaction found on market maker');
}

/**
 * Build the init_market forward_payload that goes inside a transfer_notification.
 *
 * init_market payload format:
 *   op: uint32 = 0x10 (INIT_MARKET)
 *   condition_registry: MsgAddress
 *   condition_count: uint8
 *   condition_ids: Cell ref (array of uint256)
 *   outcome_slot_counts: Cell ref (array of uint8)
 */
function buildInitMarketPayload(params: {
  conditionRegistry: Address;
  conditionIds: bigint[];
  outcomeSlotCounts: number[];
}): Cell {
  // Serialize condition_ids into a cell (array of uint256)
  const conditionIdsBuilder = beginCell();
  for (const id of params.conditionIds) {
    conditionIdsBuilder.storeUint(id, 256);
  }

  // Serialize outcome_slot_counts into a cell (array of uint8)
  const outcomeSlotCountsBuilder = beginCell();
  for (const count of params.outcomeSlotCounts) {
    outcomeSlotCountsBuilder.storeUint(count, 8);
  }

  return beginCell()
    .storeUint(MarketOpCodes.INIT_MARKET, 32)       // op
    .storeAddress(params.conditionRegistry)           // condition_registry address
    .storeUint(params.conditionIds.length, 8)        // condition_count
    .storeRef(conditionIdsBuilder.endCell())          // condition_ids as ref
    .storeRef(outcomeSlotCountsBuilder.endCell())    // outcome_slot_counts as ref
    .endCell();
}

/**
 * Build a transfer_notification message body as if sent from the MM's Jetton wallet.
 * This simulates a Jetton transfer arriving at the market maker.
 *
 * transfer_notification layout:
 *   op: uint32 = 0x7362d09c
 *   query_id: uint64
 *   amount: coins (amount of Jettons transferred)
 *   sender: MsgAddress (the original sender/creator)
 *   forward_payload: Cell ref (the init_market payload)
 */
function buildTransferNotification(params: {
  amount: bigint;
  sender: Address;
  forwardPayload: Cell;
}): Cell {
  return beginCell()
    .storeUint(0x7362d09c, 32)    // op::transfer_notification
    .storeUint(0, 64)              // query_id
    .storeCoins(params.amount)     // amount of Jettons transferred
    .storeAddress(params.sender)   // sender (the creator)
    .storeRef(params.forwardPayload) // forward_payload as ref
    .endCell();
}

// ————————————————————————————————————————————
//   Tests
// ————————————————————————————————————————————

describe('LMSR Market Maker Initialization', () => {
  let blockchain: Blockchain;
  let mm: SandboxContract<LmsrMarketMaker>;
  let deployer: SandboxContract<TreasuryContract>;
  let conditionRegistry: SandboxContract<TreasuryContract>;
  let collateralToken: SandboxContract<TreasuryContract>;
  let mmJettonWallet: Address;
  let contractCode: Cell;

  // Example condition IDs (would normally be derived from hash)
  const conditionId1 = BigInt('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const conditionId2 = BigInt('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    conditionRegistry = await blockchain.treasury('conditionRegistry');
    collateralToken = await blockchain.treasury('collateralToken');

    contractCode = loadContractCode();

    // Use a deterministic address for the MM's Jetton wallet
    const mmJettonWalletTreasury = await blockchain.treasury('mmJettonWallet');
    mmJettonWallet = mmJettonWalletTreasury.address;

    // Deploy LMSR Market Maker with initial uninitialized storage
    // Stage = 255 (uninitialized marker — before init_market is called)
    const storage: MarketStorage = {
      owner: deployer.address,
      conditionRegistry: conditionRegistry.address,
      collateralToken: collateralToken.address,
      jettonWallet: mmJettonWallet,
      funding: 0n,
      fee: 0n,
      stage: 255, // uninitialized — waiting for init_market
    };

    const contract = LmsrMarketMaker.fromStorage(storage, contractCode);
    mm = blockchain.openContract(contract);

    // Deploy the contract by sending an empty message
    await mm.sendDeploy(deployer.getSender(), toNano('0.5'));
  });

  /**
   * Helper: Send an init_market message via transfer_notification to the MM.
   * Simulates the Jetton wallet sending the notification after a Jetton transfer.
   */
  async function sendInitMarket(params: {
    amount: bigint;
    conditionIds?: bigint[];
    outcomeSlotCounts?: number[];
    sender?: Address;
    from?: Address;
  }) {
    const initPayload = buildInitMarketPayload({
      conditionRegistry: conditionRegistry.address,
      conditionIds: params.conditionIds ?? [conditionId1],
      outcomeSlotCounts: params.outcomeSlotCounts ?? [2],
    });

    const transferNotification = buildTransferNotification({
      amount: params.amount,
      sender: params.sender ?? deployer.address,
      forwardPayload: initPayload,
    });

    // Construct a proper internal Message object
    const msg: TonMessage = {
      info: {
        type: 'internal',
        ihrDisabled: true,
        bounce: true,
        bounced: false,
        src: params.from ?? mmJettonWallet,
        dest: mm.address,
        value: { coins: toNano('0.2') },
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

  // ─── Successful Initialization ────────────────────────────────────────────

  describe('successful initialization', () => {
    it('should initialize with a single 2-outcome condition', async () => {
      const fundingAmount = 1000n;

      const result = await sendInitMarket({
        amount: fundingAmount,
        conditionIds: [conditionId1],
        outcomeSlotCounts: [2],
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);

      // After init, stage should be Running (0) and funding should be stored
      const stage = await mm.getStage();
      expect(stage).toBe(STAGE_RUNNING);

      const funding = await mm.getFunding();
      expect(funding).toBe(fundingAmount);
    });

    it('should initialize with a single 3-outcome condition', async () => {
      const fundingAmount = 5000n;

      const result = await sendInitMarket({
        amount: fundingAmount,
        conditionIds: [conditionId1],
        outcomeSlotCounts: [3],
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);

      const stage = await mm.getStage();
      expect(stage).toBe(STAGE_RUNNING);

      const funding = await mm.getFunding();
      expect(funding).toBe(fundingAmount);
    });

    it('should initialize with multiple conditions (2 conditions, 4 atomic outcomes)', async () => {
      // 2 conditions: first with 2 outcomes, second with 2 outcomes
      // atomic_outcome_slot_count = 2 * 2 = 4
      const fundingAmount = 10000n;

      const result = await sendInitMarket({
        amount: fundingAmount,
        conditionIds: [conditionId1, conditionId2],
        outcomeSlotCounts: [2, 2],
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);

      const stage = await mm.getStage();
      expect(stage).toBe(STAGE_RUNNING);

      const funding = await mm.getFunding();
      expect(funding).toBe(fundingAmount);
    });
  });

  // ─── Rejection: Zero Funding ──────────────────────────────────────────────

  describe('rejection: zero funding', () => {
    it('should reject init with zero funding amount with error 302', async () => {
      const result = await sendInitMarket({
        amount: 0n,
        conditionIds: [conditionId1],
        outcomeSlotCounts: [2],
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.ZeroFunding); // 302
    });
  });

  // ─── Rejection: Already Initialized ───────────────────────────────────────

  describe('rejection: already initialized', () => {
    it('should reject second init with error 301', async () => {
      // First init — should succeed
      const firstResult = await sendInitMarket({
        amount: 1000n,
        conditionIds: [conditionId1],
        outcomeSlotCounts: [2],
      });

      const firstExitCode = getMMExitCode(firstResult.transactions, mm.address);
      expect(firstExitCode).toBe(0);

      // Second init attempt — should fail with MarketAlreadyInitialized
      const secondResult = await sendInitMarket({
        amount: 2000n,
        conditionIds: [conditionId1],
        outcomeSlotCounts: [2],
      });

      const secondExitCode = getMMExitCode(secondResult.transactions, mm.address);
      expect(secondExitCode).toBe(MarketErrors.MarketAlreadyInitialized); // 301
    });
  });
});
