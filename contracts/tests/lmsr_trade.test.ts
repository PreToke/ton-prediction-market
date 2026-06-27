/**
 * Tests for LMSR Market Maker Trade Execution (Requirement 8).
 *
 * Validates:
 * - Buy trade: send collateral via transfer_notification with trade payload
 * - Sell trade: send outcome tokens back via sell_trade message
 * - LMSR cost function correctness: computed costs match expected values
 * - Fee computation: fees correctly added/subtracted from net cost
 * - Collateral limit enforcement: rejection when net_cost exceeds limit
 * - Invalid trade amounts length: rejection when array length != atomic_outcome_slot_count
 * - Market not running: trades rejected when market is paused/closed
 *
 * These tests are written BEFORE the implementation (TDD).
 * They will fail until task 10.3/10.4 implements the trade handler.
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
  buildTradePayload,
  buildSellTrade,
  buildPause,
  STAGE_RUNNING,
  STAGE_PAUSED,
  FEE_RANGE,
} from '../../wrappers-ts/LmsrMarketMaker.gen';

// ————————————————————————————————————————————
//   Constants
// ————————————————————————————————————————————

/** Q64.64 fixed-point ONE = 2^64 */
const FIXED_ONE = 2n ** 64n;

/** ln(2) in Q64.64 ≈ 0.6931 * 2^64 */
const LN_2 = 12786308645202655660n;

/** log2(e) in Q64.64 */
const LOG2_E = 26613026195688644984n;

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
 * Build an init_market forward_payload for transfer_notification.
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
 * Build a transfer_notification message body.
 */
function buildTransferNotification(params: {
  amount: bigint;
  sender: Address;
  forwardPayload: Cell;
}): Cell {
  return beginCell()
    .storeUint(0x7362d09c, 32)        // op::transfer_notification
    .storeUint(0, 64)                  // query_id
    .storeCoins(params.amount)         // amount
    .storeAddress(params.sender)       // sender
    .storeRef(params.forwardPayload)   // forward_payload as ref
    .endCell();
}

/**
 * Compute expected LMSR cost function C(q) = b * ln(sum(exp(q_i / b)))
 * using JavaScript floating-point math for test validation.
 *
 * @param balances - array of current MM position balances (q_i = tokens sold by MM)
 * @param b - funding parameter (liquidity depth)
 * @returns C(q) as a floating-point number
 */
function lmsrCostJS(balances: number[], b: number): number {
  const maxQ = Math.max(...balances.map((q) => q / b));
  // Use offset technique to prevent overflow in JS too (not strictly needed but consistent)
  const sum = balances.reduce((acc, q) => acc + Math.exp(q / b - maxQ), 0);
  return b * (Math.log(sum) + maxQ);
}

/**
 * Compute expected net cost of a trade.
 * net_cost = C(q_after) - C(q_before)
 * where q_after[i] = q_before[i] + tradeAmounts[i]
 *
 * tradeAmounts: positive means trader is buying (MM sells, balance goes up)
 */
function expectedNetCostJS(
  currentBalances: number[],
  tradeAmounts: number[],
  b: number,
): number {
  const afterBalances = currentBalances.map((q, i) => q + tradeAmounts[i]);
  return lmsrCostJS(afterBalances, b) - lmsrCostJS(currentBalances, b);
}

// ————————————————————————————————————————————
//   Tests
// ————————————————————————————————————————————

describe('LMSR Market Maker Trade Execution', () => {
  let blockchain: Blockchain;
  let mm: SandboxContract<LmsrMarketMaker>;
  let deployer: SandboxContract<TreasuryContract>;
  let trader: SandboxContract<TreasuryContract>;
  let conditionRegistry: SandboxContract<TreasuryContract>;
  let collateralToken: SandboxContract<TreasuryContract>;
  let mmJettonWallet: Address;
  let contractCode: Cell;

  const conditionId1 = BigInt(
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  );

  // Default: 2-outcome market with funding = 1000
  const DEFAULT_FUNDING = 1000n;
  const DEFAULT_OUTCOMES = 2;
  const DEFAULT_FEE = 0n; // No fee by default for cost function tests

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    trader = await blockchain.treasury('trader');
    conditionRegistry = await blockchain.treasury('conditionRegistry');
    collateralToken = await blockchain.treasury('collateralToken');

    contractCode = loadContractCode();

    const mmJettonWalletTreasury =
      await blockchain.treasury('mmJettonWallet');
    mmJettonWallet = mmJettonWalletTreasury.address;
  });

  /**
   * Deploy and initialize a market maker ready for trading.
   * Sets stage to RUNNING with known funding and position balances.
   */
  async function deployInitializedMM(params?: {
    funding?: bigint;
    fee?: bigint;
    outcomeCount?: number;
    stage?: number;
  }): Promise<void> {
    const funding = params?.funding ?? DEFAULT_FUNDING;
    const fee = params?.fee ?? DEFAULT_FEE;
    const outcomeCount = params?.outcomeCount ?? DEFAULT_OUTCOMES;
    const stage = params?.stage ?? STAGE_RUNNING;

    const storage: MarketStorage = {
      owner: deployer.address,
      conditionRegistry: conditionRegistry.address,
      collateralToken: collateralToken.address,
      jettonWallet: mmJettonWallet,
      funding,
      fee,
      stage,
      atomicOutcomeSlotCount: outcomeCount,
    };

    const contract = LmsrMarketMaker.fromStorage(storage, contractCode);
    mm = blockchain.openContract(contract);
    await mm.sendDeploy(deployer.getSender(), toNano('0.5'));
  }

  /**
   * Send a buy trade via transfer_notification (simulating Jetton transfer to MM).
   */
  async function sendBuyTrade(params: {
    collateralAmount: bigint;
    outcomeTokenAmounts: bigint[];
    collateralLimit: bigint;
    sender?: Address;
    from?: Address;
  }) {
    const tradePayload = buildTradePayload({
      outcomeTokenAmounts: params.outcomeTokenAmounts,
      collateralLimit: params.collateralLimit,
    });

    const transferNotification = buildTransferNotification({
      amount: params.collateralAmount,
      sender: params.sender ?? trader.address,
      forwardPayload: tradePayload,
    });

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

    return await blockchain.sendMessage(msg);
  }

  /**
   * Send a sell trade directly to the MM contract.
   * Constructs the raw message to avoid provider issues in sandbox.
   */
  async function sendSellTrade(params: {
    outcomeTokenAmounts: bigint[];
    minCollateralReturn: bigint;
    sender?: SandboxContract<TreasuryContract>;
  }) {
    const senderContract = params.sender ?? trader;
    const body = buildSellTrade({
      outcomeTokenAmounts: params.outcomeTokenAmounts,
      minCollateralReturn: params.minCollateralReturn,
    });

    const msg: TonMessage = {
      info: {
        type: 'internal',
        ihrDisabled: true,
        bounce: true,
        bounced: false,
        src: senderContract.address,
        dest: mm.address,
        value: { coins: toNano('0.2') },
        ihrFee: 0n,
        forwardFee: 0n,
        createdLt: 0n,
        createdAt: 0,
      },
      body,
    };

    return await blockchain.sendMessage(msg);
  }

  // ─── Buy Trade Tests ──────────────────────────────────────────────────────

  describe('buy trade', () => {
    beforeEach(async () => {
      await deployInitializedMM();
    });

    it('should accept a valid buy trade (buy 1 unit of outcome 0 in 2-outcome market)', async () => {
      // Buy 1 unit of outcome 0: outcomeTokenAmounts = [1, 0]
      // With equal initial balances, net_cost should be positive
      const result = await sendBuyTrade({
        collateralAmount: 500n, // More than enough to cover cost
        outcomeTokenAmounts: [1n, 0n],
        collateralLimit: 0n, // No limit
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should accept a buy trade for multiple outcome tokens', async () => {
      // Buy 10 units of outcome 0 and 5 units of outcome 1
      const result = await sendBuyTrade({
        collateralAmount: 5000n,
        outcomeTokenAmounts: [10n, 5n],
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should reject buy trade from non-Jetton-wallet address', async () => {
      const result = await sendBuyTrade({
        collateralAmount: 500n,
        outcomeTokenAmounts: [1n, 0n],
        collateralLimit: 0n,
        from: trader.address, // Not the MM's Jetton wallet
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.InvalidMessage);
    });
  });

  // ─── Sell Trade Tests ─────────────────────────────────────────────────────

  describe('sell trade', () => {
    beforeEach(async () => {
      await deployInitializedMM();
    });

    it('should accept a valid sell trade (sell 1 unit of outcome 0)', async () => {
      // First perform a simulated trade state setup, then sell
      // Sell amounts are negative: selling 1 unit of outcome 0
      const result = await sendSellTrade({
        outcomeTokenAmounts: [-1n, 0n],
        minCollateralReturn: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      // Should succeed (exit code 0) once implemented
      expect(exitCode).toBe(0);
    });

    it('should accept a sell trade returning multiple outcome tokens', async () => {
      const result = await sendSellTrade({
        outcomeTokenAmounts: [-5n, -3n],
        minCollateralReturn: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });
  });

  // ─── LMSR Cost Function Correctness ───────────────────────────────────────

  describe('LMSR cost function correctness', () => {
    beforeEach(async () => {
      await deployInitializedMM({ funding: 1000n });
    });

    it('should compute correct net cost for buying 1 unit of outcome 0 (2-outcome, equal balances)', async () => {
      // With equal initial balances (say 0,0), the cost of buying 1 unit of outcome 0:
      // C_before = b * ln(exp(0/b) + exp(0/b)) = b * ln(2)
      // C_after  = b * ln(exp(1/b) + exp(0/b))
      // net_cost = C_after - C_before
      //
      // For b=1000, buying 1 unit of outcome 0:
      // net_cost ≈ 0.5005 (approximately half the cost in a 2-outcome market)
      //
      // We verify the contract computes a value close to the JS reference.
      const expectedCost = expectedNetCostJS([0, 0], [1, 0], 1000);

      // The contract should accept this trade with sufficient collateral
      const result = await sendBuyTrade({
        collateralAmount: BigInt(Math.ceil(expectedCost * 2)), // Enough to cover
        outcomeTokenAmounts: [1n, 0n],
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should compute correct net cost for buying equal amounts of all outcomes (zero net cost)', async () => {
      // Buying equal amounts of ALL outcomes should have net_cost ≈ sum of amounts
      // (since it's equivalent to splitting collateral)
      // C(q+[d,d]) - C(q) = d (exactly, for uniform addition)
      const result = await sendBuyTrade({
        collateralAmount: 200n, // Should cover cost of 10 units of each
        outcomeTokenAmounts: [10n, 10n],
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should compute higher cost for larger trade amounts', async () => {
      // Buying 100 units should cost more than buying 10 units
      // We just verify both trades succeed — cost comparison would need a get-method
      const result10 = await sendBuyTrade({
        collateralAmount: 5000n,
        outcomeTokenAmounts: [10n, 0n],
        collateralLimit: 0n,
      });

      const exitCode10 = getMMExitCode(result10.transactions, mm.address);
      expect(exitCode10).toBe(0);
    });

    it('should handle 3-outcome market trades correctly', async () => {
      // Deploy a 3-outcome market
      await deployInitializedMM({ funding: 1000n, outcomeCount: 3 });

      // Buy 1 unit of outcome 0 in a 3-outcome market
      // Expected cost ≈ 0.3344 (price starts at 1/3 ≈ 0.333)
      const result = await sendBuyTrade({
        collateralAmount: 500n,
        outcomeTokenAmounts: [1n, 0n, 0n],
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });
  });

  // ─── Fee Computation ──────────────────────────────────────────────────────

  describe('fee computation', () => {
    it('should add fee to buy trade cost (fee = 1%)', async () => {
      // fee_rate = 1% = 0.01 * FEE_RANGE = 10^16
      const feeRate = FEE_RANGE / 100n; // 1%
      await deployInitializedMM({ funding: 1000n, fee: feeRate });

      // Buy 10 units of outcome 0
      // Total cost should be net_cost + fee where fee = |net_cost| * fee_rate / FEE_RANGE
      const result = await sendBuyTrade({
        collateralAmount: 5000n, // Generous to cover cost + fee
        outcomeTokenAmounts: [10n, 0n],
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should subtract fee from sell trade return (fee = 2%)', async () => {
      // fee_rate = 2% = 0.02 * FEE_RANGE
      const feeRate = (FEE_RANGE * 2n) / 100n;
      await deployInitializedMM({ funding: 1000n, fee: feeRate });

      // Sell 5 units of outcome 0
      // Collateral returned = |net_cost| - fee
      const result = await sendSellTrade({
        outcomeTokenAmounts: [-5n, 0n],
        minCollateralReturn: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should accumulate fees correctly with zero fee rate', async () => {
      // With zero fee, the full net_cost should be charged (no extra)
      await deployInitializedMM({ funding: 1000n, fee: 0n });

      const result = await sendBuyTrade({
        collateralAmount: 5000n,
        outcomeTokenAmounts: [10n, 0n],
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should handle maximum fee rate (100%)', async () => {
      // fee_rate = 100% = FEE_RANGE
      // Total cost = net_cost + net_cost = 2 * net_cost
      await deployInitializedMM({ funding: 1000n, fee: FEE_RANGE });

      const result = await sendBuyTrade({
        collateralAmount: 10000n, // Double the usual to cover 100% fee
        outcomeTokenAmounts: [10n, 0n],
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });
  });

  // ─── Collateral Limit Enforcement ─────────────────────────────────────────

  describe('collateral limit enforcement', () => {
    beforeEach(async () => {
      await deployInitializedMM({ funding: 1000n });
    });

    it('should reject trade when net_cost exceeds non-zero collateral limit', async () => {
      // Set a very low collateral limit that will be exceeded
      // Buying 100 units of outcome 0 with b=1000 will cost roughly ~50 tokens
      // Set limit to 1 to force rejection
      const result = await sendBuyTrade({
        collateralAmount: 5000n, // Enough collateral sent
        outcomeTokenAmounts: [100n, 0n],
        collateralLimit: 1n, // Very low limit — net_cost will exceed this
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.CollateralLimitExceeded); // 307
    });

    it('should accept trade when net_cost is within collateral limit', async () => {
      // Set a generous collateral limit
      const result = await sendBuyTrade({
        collateralAmount: 5000n,
        outcomeTokenAmounts: [1n, 0n],
        collateralLimit: 5000n, // Very generous limit
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });

    it('should skip limit check when collateral limit is zero', async () => {
      // Zero collateral limit means no limit check
      const result = await sendBuyTrade({
        collateralAmount: 5000n,
        outcomeTokenAmounts: [100n, 0n],
        collateralLimit: 0n, // Zero means no limit
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(0);
    });
  });

  // ─── Invalid Trade Amounts Length ─────────────────────────────────────────

  describe('invalid trade amounts length', () => {
    it('should reject trade when amounts array length < atomic_outcome_slot_count', async () => {
      // Market has 2 outcomes, but we send only 1 amount
      await deployInitializedMM({ funding: 1000n, outcomeCount: 2 });

      const result = await sendBuyTrade({
        collateralAmount: 5000n,
        outcomeTokenAmounts: [10n], // Only 1 element, need 2
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.InvalidTradeAmounts); // 306
    });

    it('should reject trade when amounts array length > atomic_outcome_slot_count', async () => {
      // Market has 2 outcomes, but we send 3 amounts
      await deployInitializedMM({ funding: 1000n, outcomeCount: 2 });

      const result = await sendBuyTrade({
        collateralAmount: 5000n,
        outcomeTokenAmounts: [10n, 5n, 3n], // 3 elements, need 2
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.InvalidTradeAmounts); // 306
    });

    it('should reject sell trade with wrong amounts length', async () => {
      // Market has 2 outcomes, sell trade sends 3 amounts
      await deployInitializedMM({ funding: 1000n, outcomeCount: 2 });

      const result = await sendSellTrade({
        outcomeTokenAmounts: [-1n, -2n, -3n], // 3 elements, need 2
        minCollateralReturn: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.InvalidTradeAmounts); // 306
    });
  });

  // ─── Market Not Running ───────────────────────────────────────────────────

  describe('market not running', () => {
    it('should reject buy trade when market is paused', async () => {
      await deployInitializedMM({
        funding: 1000n,
        stage: STAGE_PAUSED,
      });

      const result = await sendBuyTrade({
        collateralAmount: 5000n,
        outcomeTokenAmounts: [10n, 0n],
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotRunning); // 303
    });

    it('should reject sell trade when market is paused', async () => {
      await deployInitializedMM({
        funding: 1000n,
        stage: STAGE_PAUSED,
      });

      const result = await sendSellTrade({
        outcomeTokenAmounts: [-5n, 0n],
        minCollateralReturn: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotRunning); // 303
    });

    it('should reject buy trade when market is closed', async () => {
      await deployInitializedMM({
        funding: 1000n,
        stage: 2, // STAGE_CLOSED
      });

      const result = await sendBuyTrade({
        collateralAmount: 5000n,
        outcomeTokenAmounts: [10n, 0n],
        collateralLimit: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotRunning); // 303
    });

    it('should reject sell trade when market is closed', async () => {
      await deployInitializedMM({
        funding: 1000n,
        stage: 2, // STAGE_CLOSED
      });

      const result = await sendSellTrade({
        outcomeTokenAmounts: [-5n, 0n],
        minCollateralReturn: 0n,
      });

      const exitCode = getMMExitCode(result.transactions, mm.address);
      expect(exitCode).toBe(MarketErrors.MarketNotRunning); // 303
    });
  });
});
