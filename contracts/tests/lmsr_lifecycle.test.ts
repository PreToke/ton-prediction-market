/**
 * Tests for LMSR Market Maker Lifecycle, Fee Management, and Funding Changes.
 *
 * Validates Requirements 10, 11, 12:
 * - Pause/Resume/Close state transitions (Requirement 11)
 * - Owner-only access control for all admin operations (Requirement 11.5)
 * - Fee change and withdrawal (Requirement 10)
 * - Funding changes while paused (Requirement 12)
 *
 * These tests are written BEFORE the implementation (TDD).
 * They will fail until tasks 11.2/11.3 implement the handlers.
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
  STAGE_RUNNING,
  STAGE_PAUSED,
  STAGE_CLOSED,
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
 * Build the init_market forward_payload.
 */
function buildInitMarketPayload(params: {
  conditionRegistry: Address;
  conditionIds: bigint[];
  outcomeSlotCounts: number[];
}): Cell {
  const conditionIdsBuilder = beginCell();
  for (const id of params.conditionIds) {
    conditionIdsBuilder.storeUint(id, 256);
  }

  const outcomeSlotCountsBuilder = beginCell();
  for (const count of params.outcomeSlotCounts) {
    outcomeSlotCountsBuilder.storeUint(count, 8);
  }

  return beginCell()
    .storeUint(MarketOpCodes.INIT_MARKET, 32)
    .storeAddress(params.conditionRegistry)
    .storeUint(params.conditionIds.length, 8)
    .storeRef(conditionIdsBuilder.endCell())
    .storeRef(outcomeSlotCountsBuilder.endCell())
    .endCell();
}

/**
 * Build a transfer_notification message body (simulates Jetton wallet notification).
 */
function buildTransferNotification(params: {
  amount: bigint;
  sender: Address;
  forwardPayload: Cell;
}): Cell {
  return beginCell()
    .storeUint(0x7362d09c, 32)
    .storeUint(0, 64)
    .storeCoins(params.amount)
    .storeAddress(params.sender)
    .storeRef(params.forwardPayload)
    .endCell();
}

// ————————————————————————————————————————————
//   Tests
// ————————————————————————————————————————————

describe('LMSR Market Maker Lifecycle', () => {
  let blockchain: Blockchain;
  let mm: SandboxContract<LmsrMarketMaker>;
  let owner: SandboxContract<TreasuryContract>;
  let nonOwner: SandboxContract<TreasuryContract>;
  let conditionRegistry: SandboxContract<TreasuryContract>;
  let collateralToken: SandboxContract<TreasuryContract>;
  let mmJettonWallet: Address;
  let contractCode: Cell;

  const conditionId1 = BigInt('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  const FUNDING_AMOUNT = 10000n;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    owner = await blockchain.treasury('owner');
    nonOwner = await blockchain.treasury('nonOwner');
    conditionRegistry = await blockchain.treasury('conditionRegistry');
    collateralToken = await blockchain.treasury('collateralToken');

    contractCode = loadContractCode();

    const mmJettonWalletTreasury = await blockchain.treasury('mmJettonWallet');
    mmJettonWallet = mmJettonWalletTreasury.address;

    // Deploy and initialize the market maker so it starts in Running state
    const storage: MarketStorage = {
      owner: owner.address,
      conditionRegistry: conditionRegistry.address,
      collateralToken: collateralToken.address,
      jettonWallet: mmJettonWallet,
      funding: 0n,
      fee: 0n,
      stage: 255, // uninitialized
    };

    const contract = LmsrMarketMaker.fromStorage(storage, contractCode);
    mm = blockchain.openContract(contract);

    // Deploy the contract
    await mm.sendDeploy(owner.getSender(), toNano('0.5'));

    // Initialize with funding via transfer_notification
    const initPayload = buildInitMarketPayload({
      conditionRegistry: conditionRegistry.address,
      conditionIds: [conditionId1],
      outcomeSlotCounts: [2],
    });

    const transferNotification = buildTransferNotification({
      amount: FUNDING_AMOUNT,
      sender: owner.address,
      forwardPayload: initPayload,
    });

    const msg: TonMessage = {
      info: {
        type: 'internal',
        ihrDisabled: true,
        bounce: true,
        bounced: false,
        src: mmJettonWallet,
        dest: mm.address,
        value: { coins: toNano('0.2') },
        ihrFee: 0n,
        forwardFee: 0n,
        createdLt: 0n,
        createdAt: 0,
      },
      body: transferNotification,
    };

    const initResult = await blockchain.sendMessage(msg);
    const exitCode = getMMExitCode(initResult.transactions, mm.address);
    expect(exitCode).toBe(0);

    // Verify market is now running
    const stage = await mm.getStage();
    expect(stage).toBe(STAGE_RUNNING);
  });

  // ─── Pause ────────────────────────────────────────────────────────────────

  describe('Pause (Requirement 11.1)', () => {
    it('should allow owner to pause a running market', async () => {
      const result = await mm.sendPause(owner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);

      const stage = await mm.getStage();
      expect(stage).toBe(STAGE_PAUSED);
    });

    it('should reject pause from non-owner with error 300 (NotOwner)', async () => {
      const result = await mm.sendPause(nonOwner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.NotOwner);
    });

    it('should reject pause when already paused with error 303 (MarketNotRunning)', async () => {
      // First pause
      await mm.sendPause(owner.getSender(), toNano('0.2'));
      const stage = await mm.getStage();
      expect(stage).toBe(STAGE_PAUSED);

      // Second pause attempt
      const result = await mm.sendPause(owner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotRunning);
    });
  });

  // ─── Resume ───────────────────────────────────────────────────────────────

  describe('Resume (Requirement 11.2)', () => {
    it('should allow owner to resume a paused market', async () => {
      // Pause first
      await mm.sendPause(owner.getSender(), toNano('0.2'));
      expect(await mm.getStage()).toBe(STAGE_PAUSED);

      // Resume
      const result = await mm.sendResume(owner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);

      const stage = await mm.getStage();
      expect(stage).toBe(STAGE_RUNNING);
    });

    it('should reject resume from non-owner with error 300 (NotOwner)', async () => {
      // Pause first
      await mm.sendPause(owner.getSender(), toNano('0.2'));

      const result = await mm.sendResume(nonOwner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.NotOwner);
    });

    it('should reject resume when market is not paused (Running) with error 304 (MarketNotPaused)', async () => {
      // Market is already Running - try to resume without pausing first
      const result = await mm.sendResume(owner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotPaused);
    });
  });

  // ─── Close ────────────────────────────────────────────────────────────────

  describe('Close (Requirement 11.3)', () => {
    it('should allow owner to close a running market', async () => {
      const result = await mm.sendClose(owner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);

      const stage = await mm.getStage();
      expect(stage).toBe(STAGE_CLOSED);
    });

    it('should allow owner to close a paused market', async () => {
      // Pause first
      await mm.sendPause(owner.getSender(), toNano('0.2'));
      expect(await mm.getStage()).toBe(STAGE_PAUSED);

      // Close from paused state
      const result = await mm.sendClose(owner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);

      const stage = await mm.getStage();
      expect(stage).toBe(STAGE_CLOSED);
    });

    it('should reject close from non-owner with error 300 (NotOwner)', async () => {
      const result = await mm.sendClose(nonOwner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.NotOwner);
    });

    it('should reject close when already closed with error 305 (MarketClosed)', async () => {
      // Close first
      await mm.sendClose(owner.getSender(), toNano('0.2'));
      expect(await mm.getStage()).toBe(STAGE_CLOSED);

      // Try closing again
      const result = await mm.sendClose(owner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketClosed);
    });
  });

  // ─── Change Fee ───────────────────────────────────────────────────────────

  describe('Change Fee (Requirement 10.1)', () => {
    it('should allow owner to change fee on a running market', async () => {
      const newFee = 50000000000000000n; // 5% (5e16 / 1e18)
      const result = await mm.sendChangeFee(owner.getSender(), toNano('0.2'), newFee);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should allow owner to change fee on a paused market', async () => {
      // Pause first
      await mm.sendPause(owner.getSender(), toNano('0.2'));

      const newFee = 100000000000000000n; // 10%
      const result = await mm.sendChangeFee(owner.getSender(), toNano('0.2'), newFee);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should reject change_fee from non-owner with error 300 (NotOwner)', async () => {
      const newFee = 50000000000000000n;
      const result = await mm.sendChangeFee(nonOwner.getSender(), toNano('0.2'), newFee);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.NotOwner);
    });

    it('should reject change_fee when market is closed with error 305 (MarketClosed)', async () => {
      // Close the market
      await mm.sendClose(owner.getSender(), toNano('0.2'));

      const newFee = 50000000000000000n;
      const result = await mm.sendChangeFee(owner.getSender(), toNano('0.2'), newFee);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketClosed);
    });
  });

  // ─── Withdraw Fees ────────────────────────────────────────────────────────

  describe('Withdraw Fees (Requirement 10.3)', () => {
    it('should allow owner to withdraw accumulated fees', async () => {
      const result = await mm.sendWithdrawFees(owner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should reject withdraw_fees from non-owner with error 300 (NotOwner)', async () => {
      const result = await mm.sendWithdrawFees(nonOwner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.NotOwner);
    });

    it('should reject withdraw_fees when market is closed with error 305 (MarketClosed)', async () => {
      // Close the market
      await mm.sendClose(owner.getSender(), toNano('0.2'));

      const result = await mm.sendWithdrawFees(owner.getSender(), toNano('0.2'));
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketClosed);
    });
  });

  // ─── Change Funding ───────────────────────────────────────────────────────

  describe('Change Funding (Requirement 12)', () => {
    it('should allow owner to increase funding when paused', async () => {
      // Pause first (required for change_funding)
      await mm.sendPause(owner.getSender(), toNano('0.2'));
      expect(await mm.getStage()).toBe(STAGE_PAUSED);

      const fundingChange = 5000n; // positive = add funding
      const result = await mm.sendChangeFunding(owner.getSender(), toNano('0.2'), fundingChange);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);

      // Verify funding increased
      const funding = await mm.getFunding();
      expect(funding).toBe(FUNDING_AMOUNT + fundingChange);
    });

    it('should allow owner to decrease funding when paused', async () => {
      // Pause first
      await mm.sendPause(owner.getSender(), toNano('0.2'));

      const fundingChange = -3000n; // negative = remove funding
      const result = await mm.sendChangeFunding(owner.getSender(), toNano('0.2'), fundingChange);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);

      // Verify funding decreased
      const funding = await mm.getFunding();
      expect(funding).toBe(FUNDING_AMOUNT + fundingChange); // 10000 - 3000 = 7000
    });

    it('should reject change_funding with zero amount with error 309 (ZeroFundingChange)', async () => {
      // Pause first
      await mm.sendPause(owner.getSender(), toNano('0.2'));

      const fundingChange = 0n;
      const result = await mm.sendChangeFunding(owner.getSender(), toNano('0.2'), fundingChange);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.ZeroFundingChange);
    });

    it('should reject change_funding when market is Running with error 304 (MarketNotPaused)', async () => {
      // Market is Running - should not allow funding changes
      const fundingChange = 5000n;
      const result = await mm.sendChangeFunding(owner.getSender(), toNano('0.2'), fundingChange);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotPaused);
    });

    it('should reject change_funding from non-owner with error 300 (NotOwner)', async () => {
      // Pause first
      await mm.sendPause(owner.getSender(), toNano('0.2'));

      const fundingChange = 5000n;
      const result = await mm.sendChangeFunding(nonOwner.getSender(), toNano('0.2'), fundingChange);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.NotOwner);
    });
  });

  // ─── State Transition Validation ──────────────────────────────────────────

  describe('State Transition Validation', () => {
    it('should reject trades when market is paused', async () => {
      // Pause the market
      await mm.sendPause(owner.getSender(), toNano('0.2'));
      expect(await mm.getStage()).toBe(STAGE_PAUSED);

      // Attempt a sell trade (direct message, not via transfer_notification)
      const tradeAmountsCell = beginCell()
        .storeInt(100n, 64)
        .storeInt(-100n, 64)
        .endCell();

      const sellTradeBody = beginCell()
        .storeUint(MarketOpCodes.SELL_TRADE, 32)
        .storeUint(0n, 64) // queryId
        .storeRef(tradeAmountsCell)
        .storeCoins(0n) // minCollateralReturn
        .endCell();

      const msg: TonMessage = {
        info: {
          type: 'internal',
          ihrDisabled: true,
          bounce: true,
          bounced: false,
          src: owner.address,
          dest: mm.address,
          value: { coins: toNano('0.2') },
          ihrFee: 0n,
          forwardFee: 0n,
          createdLt: 0n,
          createdAt: 0,
        },
        body: sellTradeBody,
      };

      const result = await blockchain.sendMessage(msg);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotRunning);
    });

    it('should reject trades when market is closed', async () => {
      // Close the market
      await mm.sendClose(owner.getSender(), toNano('0.2'));
      expect(await mm.getStage()).toBe(STAGE_CLOSED);

      // Attempt a sell trade
      const tradeAmountsCell = beginCell()
        .storeInt(100n, 64)
        .storeInt(-100n, 64)
        .endCell();

      const sellTradeBody = beginCell()
        .storeUint(MarketOpCodes.SELL_TRADE, 32)
        .storeUint(0n, 64)
        .storeRef(tradeAmountsCell)
        .storeCoins(0n)
        .endCell();

      const msg: TonMessage = {
        info: {
          type: 'internal',
          ihrDisabled: true,
          bounce: true,
          bounced: false,
          src: owner.address,
          dest: mm.address,
          value: { coins: toNano('0.2') },
          ihrFee: 0n,
          forwardFee: 0n,
          createdLt: 0n,
          createdAt: 0,
        },
        body: sellTradeBody,
      };

      const result = await blockchain.sendMessage(msg);
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotRunning);
    });

    it('should reject buy trades (via transfer_notification) when market is paused', async () => {
      // Pause the market
      await mm.sendPause(owner.getSender(), toNano('0.2'));
      expect(await mm.getStage()).toBe(STAGE_PAUSED);

      // Attempt a buy trade via transfer_notification
      const tradeAmountsCell = beginCell()
        .storeInt(100n, 64)
        .storeInt(-100n, 64)
        .endCell();

      const tradePayload = beginCell()
        .storeUint(MarketOpCodes.TRADE, 32)
        .storeRef(tradeAmountsCell)
        .storeInt(0n, 128) // collateralLimit
        .endCell();

      const transferNotification = buildTransferNotification({
        amount: 1000n,
        sender: owner.address,
        forwardPayload: tradePayload,
      });

      const msg: TonMessage = {
        info: {
          type: 'internal',
          ihrDisabled: true,
          bounce: true,
          bounced: false,
          src: mmJettonWallet,
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
      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotRunning);
    });

    it('should allow pause → change_fee → resume round-trip', async () => {
      // Pause
      await mm.sendPause(owner.getSender(), toNano('0.2'));
      expect(await mm.getStage()).toBe(STAGE_PAUSED);

      // Change fee while paused
      const newFee = 30000000000000000n; // 3%
      const feeResult = await mm.sendChangeFee(owner.getSender(), toNano('0.2'), newFee);
      expect(getMMExitCode(feeResult.transactions, mm.address)).toBe(0);

      // Resume
      const resumeResult = await mm.sendResume(owner.getSender(), toNano('0.2'));
      expect(getMMExitCode(resumeResult.transactions, mm.address)).toBe(0);
      expect(await mm.getStage()).toBe(STAGE_RUNNING);
    });

    it('should allow pause → change_funding → resume round-trip', async () => {
      // Pause
      await mm.sendPause(owner.getSender(), toNano('0.2'));
      expect(await mm.getStage()).toBe(STAGE_PAUSED);

      // Change funding while paused
      const fundingChange = 2000n;
      const fundResult = await mm.sendChangeFunding(owner.getSender(), toNano('0.2'), fundingChange);
      expect(getMMExitCode(fundResult.transactions, mm.address)).toBe(0);

      // Resume
      const resumeResult = await mm.sendResume(owner.getSender(), toNano('0.2'));
      expect(getMMExitCode(resumeResult.transactions, mm.address)).toBe(0);
      expect(await mm.getStage()).toBe(STAGE_RUNNING);

      // Verify funding was updated
      const funding = await mm.getFunding();
      expect(funding).toBe(FUNDING_AMOUNT + fundingChange);
    });
  });
});
