/**
 * Integration Tests: Multiple Traders, Market Lifecycle, and Funding Changes
 *
 * Exercises:
 *   - Multiple traders making independent trades
 *   - Market lifecycle state transitions (pause → change funding/fee → resume → close)
 *   - Funding changes while paused
 *   - Trade rejection after close
 *   - Oracle resolution and redemption
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
  buildRedeemPositions,
} from '../../wrappers-ts/ConditionRegistry.gen';
import {
  LmsrMarketMaker,
  MarketOpCodes,
  MarketErrors,
  MarketStorage,
  marketStorageToCell,
  buildTradePayload,
  STAGE_RUNNING,
  STAGE_PAUSED,
  STAGE_CLOSED,
} from '../../wrappers-ts/LmsrMarketMaker.gen';

// ————————————————————————————————————————————
//   Helpers
// ————————————————————————————————————————————

/** Load compiled Condition Registry contract code */
function loadRegistryCode(): Cell {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const artifact = require('../../build/ConditionRegistry.json');
  return Cell.fromBase64(artifact.code_boc64);
}

/** Load compiled LMSR Market Maker contract code */
function loadMarketMakerCode(): Cell {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const artifact = require('../../build/LmsrMarketMaker.json');
  return Cell.fromBase64(artifact.code_boc64);
}

/** Convert an Address to the bigint format used by sandbox transaction.address */
function addressToBigint(address: Address): bigint {
  return BigInt('0x' + address.hash.toString('hex'));
}

/**
 * Extract the exit code from a transaction targeting a specific contract address.
 */
function getExitCode(
  transactions: BlockchainTransaction[],
  contractAddress: Address,
): number {
  const contractHash = addressToBigint(contractAddress);

  for (let i = transactions.length - 1; i >= 0; i--) {
    const tx = transactions[i];
    if (tx.address === contractHash && tx.description.type === 'generic') {
      const computePhase = tx.description.computePhase;
      if (computePhase.type === 'vm') {
        return computePhase.exitCode;
      }
    }
  }
  throw new Error(`No VM transaction found on contract ${contractAddress}`);
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
 * Build an init_market forward_payload for the LMSR Market Maker.
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

// ————————————————————————————————————————————
//   Tests
// ————————————————————————————————————————————

describe('Integration: Multiple Traders, Market Lifecycle & Funding Changes', () => {
  let blockchain: Blockchain;
  let registry: SandboxContract<ConditionRegistry>;
  let mm: SandboxContract<LmsrMarketMaker>;
  let deployer: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let trader1: SandboxContract<TreasuryContract>;
  let trader2: SandboxContract<TreasuryContract>;
  let trader3: SandboxContract<TreasuryContract>;
  let jettonMaster: SandboxContract<TreasuryContract>;
  let registryJettonWallet: Address;
  let mmJettonWallet: Address;
  let registryCode: Cell;
  let mmCode: Cell;

  const questionId = 42n; // "Will TON exceed $10?"
  const outcomeSlotCount = 2; // Binary: Yes/No

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    oracle = await blockchain.treasury('oracle');
    trader1 = await blockchain.treasury('trader1');
    trader2 = await blockchain.treasury('trader2');
    trader3 = await blockchain.treasury('trader3');
    jettonMaster = await blockchain.treasury('jettonMaster');

    registryCode = loadRegistryCode();
    mmCode = loadMarketMakerCode();

    // Set up Jetton wallet addresses for both contracts
    const registryJettonWalletTreasury = await blockchain.treasury('registryJettonWallet');
    registryJettonWallet = registryJettonWalletTreasury.address;

    const mmJettonWalletTreasury = await blockchain.treasury('mmJettonWallet');
    mmJettonWallet = mmJettonWalletTreasury.address;

    // Deploy Condition Registry
    const registryContract = ConditionRegistry.fromStorage(
      { owner: deployer.address, jettonWallet: registryJettonWallet, collateralToken: jettonMaster.address },
      registryCode,
    );
    registry = blockchain.openContract(registryContract);
    await registry.sendDeploy(deployer.getSender(), toNano('0.5'));

    // Deploy LMSR Market Maker (uninitialized — stage 255)
    const mmStorage: MarketStorage = {
      owner: deployer.address,
      conditionRegistry: registry.address,
      collateralToken: jettonMaster.address,
      jettonWallet: mmJettonWallet,
      funding: 0n,
      fee: 0n,
      stage: 255, // uninitialized
    };
    const mmContract = LmsrMarketMaker.fromStorage(mmStorage, mmCode);
    mm = blockchain.openContract(mmContract);
    await mm.sendDeploy(deployer.getSender(), toNano('0.5'));
  });

  // ─── Helper Functions ─────────────────────────────────────────────────────

  /**
   * Prepare a condition on the registry.
   */
  async function prepareCondition(): Promise<bigint> {
    const result = await registry.sendPrepareCondition(
      deployer.getSender(),
      toNano('0.2'),
      {
        oracle: oracle.address,
        questionId,
        outcomeSlotCount,
      },
    );
    const exitCode = getExitCode(result.transactions, registry.address);
    expect(exitCode).toBe(0);
    return computeConditionId(oracle.address, questionId, outcomeSlotCount);
  }

  /**
   * Initialize the Market Maker with funding.
   */
  async function initMarketMaker(conditionId: bigint, funding: bigint) {
    const initPayload = buildInitMarketPayload({
      conditionRegistry: registry.address,
      conditionIds: [conditionId],
      outcomeSlotCounts: [outcomeSlotCount],
    });

    const transferNotification = buildTransferNotification({
      amount: funding,
      sender: deployer.address,
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

    return await blockchain.sendMessage(msg);
  }

  /**
   * Execute a buy trade via the Market Maker on behalf of a specific trader.
   */
  async function executeBuyTrade(params: {
    trader: SandboxContract<TreasuryContract>;
    collateralAmount: bigint;
    outcomeTokenAmounts: bigint[];
    collateralLimit: bigint;
  }) {
    const tradePayload = buildTradePayload({
      outcomeTokenAmounts: params.outcomeTokenAmounts,
      collateralLimit: params.collateralLimit,
    });

    const transferNotification = buildTransferNotification({
      amount: params.collateralAmount,
      sender: params.trader.address,
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

    return await blockchain.sendMessage(msg);
  }

  /**
   * Oracle resolves the condition.
   */
  async function resolveCondition(payouts: bigint[]) {
    return await registry.sendReportPayouts(
      oracle.getSender(),
      toNano('0.2'),
      {
        questionId,
        payouts,
      },
    );
  }

  /**
   * Redeem positions for a specific trader.
   */
  async function redeemPositions(
    trader: SandboxContract<TreasuryContract>,
    conditionId: bigint,
    indexSets: bigint[],
  ) {
    return await registry.sendRedeemPositions(
      trader.getSender(),
      toNano('0.2'),
      {
        collateralToken: jettonMaster.address,
        parentCollectionId: 0n,
        conditionId,
        indexSets,
      },
    );
  }

  // ─── Main Integration Test ────────────────────────────────────────────────

  it('should handle multiple traders, lifecycle transitions, funding changes, close, resolution and redemption', async () => {
    // ═══ Step 1: Prepare a condition ═══
    const conditionId = await prepareCondition();

    // Verify condition exists
    const condition = await registry.getCondition(conditionId);
    expect(condition.outcomeSlotCount).toBe(outcomeSlotCount);
    expect(condition.payoutDenominator).toBe(0n);

    // ═══ Step 2: Initialize Market Maker ═══
    const initialFunding = 1000n;
    const initResult = await initMarketMaker(conditionId, initialFunding);
    const initExitCode = getExitCode(initResult.transactions, mm.address);
    expect(initExitCode).toBe(0);

    // Verify MM is running
    const stage = await mm.getStage();
    expect(stage).toBe(STAGE_RUNNING);
    const storedFunding = await mm.getFunding();
    expect(storedFunding).toBe(initialFunding);

    // ═══ Step 3: Trader 1 buys outcome 0 (Yes) ═══
    const trade1Result = await executeBuyTrade({
      trader: trader1,
      collateralAmount: 500n,
      outcomeTokenAmounts: [10n, 0n],
      collateralLimit: 0n,
    });
    const trade1ExitCode = getExitCode(trade1Result.transactions, mm.address);
    expect(trade1ExitCode).toBe(0);

    // ═══ Step 4: Trader 2 buys outcome 1 (No) ═══
    const trade2Result = await executeBuyTrade({
      trader: trader2,
      collateralAmount: 500n,
      outcomeTokenAmounts: [0n, 10n],
      collateralLimit: 0n,
    });
    const trade2ExitCode = getExitCode(trade2Result.transactions, mm.address);
    expect(trade2ExitCode).toBe(0);

    // ═══ Step 5: Owner pauses the market ═══
    const pauseResult = await mm.sendPause(
      deployer.getSender(),
      toNano('0.2'),
    );
    const pauseExitCode = getExitCode(pauseResult.transactions, mm.address);
    expect(pauseExitCode).toBe(0);

    // Verify market is paused
    const pausedStage = await mm.getStage();
    expect(pausedStage).toBe(STAGE_PAUSED);

    // ═══ Step 6: Owner increases funding while paused ═══
    const fundingChangeResult = await mm.sendChangeFunding(
      deployer.getSender(),
      toNano('0.2'),
      500n, // add 500 to funding
    );
    const fundingChangeExitCode = getExitCode(fundingChangeResult.transactions, mm.address);
    expect(fundingChangeExitCode).toBe(0);

    // Verify funding increased
    const newFunding = await mm.getFunding();
    expect(newFunding).toBe(initialFunding + 500n);

    // ═══ Step 7: Owner changes fee while paused ═══
    const newFee = 50000000000000000n; // 5% fee (5 * 10^16 / 10^18)
    const changeFeeResult = await mm.sendChangeFee(
      deployer.getSender(),
      toNano('0.2'),
      newFee,
    );
    const changeFeeExitCode = getExitCode(changeFeeResult.transactions, mm.address);
    expect(changeFeeExitCode).toBe(0);

    // ═══ Step 8: Owner resumes the market ═══
    const resumeResult = await mm.sendResume(
      deployer.getSender(),
      toNano('0.2'),
    );
    const resumeExitCode = getExitCode(resumeResult.transactions, mm.address);
    expect(resumeExitCode).toBe(0);

    // Verify market is running again
    const resumedStage = await mm.getStage();
    expect(resumedStage).toBe(STAGE_RUNNING);

    // ═══ Step 9: Trader 3 buys outcome 0 (affected by new funding/fee) ═══
    const trade3Result = await executeBuyTrade({
      trader: trader3,
      collateralAmount: 500n,
      outcomeTokenAmounts: [5n, 0n],
      collateralLimit: 0n,
    });
    const trade3ExitCode = getExitCode(trade3Result.transactions, mm.address);
    expect(trade3ExitCode).toBe(0);

    // ═══ Step 10: Owner closes the market ═══
    const closeResult = await mm.sendClose(
      deployer.getSender(),
      toNano('0.2'),
    );
    const closeExitCode = getExitCode(closeResult.transactions, mm.address);
    expect(closeExitCode).toBe(0);

    // Verify market is closed
    const closedStage = await mm.getStage();
    expect(closedStage).toBe(STAGE_CLOSED);

    // ═══ Step 11: Verify trades are rejected after close ═══
    const rejectedTradeResult = await executeBuyTrade({
      trader: trader1,
      collateralAmount: 500n,
      outcomeTokenAmounts: [5n, 0n],
      collateralLimit: 0n,
    });
    const rejectedExitCode = getExitCode(rejectedTradeResult.transactions, mm.address);
    // Trade should fail with MarketNotRunning or MarketClosed error
    expect(rejectedExitCode).not.toBe(0);

    // ═══ Step 12: Oracle resolves the condition ═══
    // Outcome 0 (Yes) wins
    const resolveResult = await resolveCondition([1n, 0n]);
    const resolveExitCode = getExitCode(resolveResult.transactions, registry.address);
    expect(resolveExitCode).toBe(0);

    // Verify condition is resolved
    const resolvedCondition = await registry.getCondition(conditionId);
    expect(resolvedCondition.payoutDenominator).toBeGreaterThan(0n);

    // ═══ Step 13: Traders redeem their positions ═══
    // Trader 1 redeems outcome 0 (winning position)
    const redeem1Result = await redeemPositions(trader1, conditionId, [1n]);
    const redeem1ExitCode = getExitCode(redeem1Result.transactions, registry.address);
    expect(redeem1ExitCode).toBe(0);

    // Trader 2 redeems outcome 1 (losing position — zero payout)
    const redeem2Result = await redeemPositions(trader2, conditionId, [2n]);
    const redeem2ExitCode = getExitCode(redeem2Result.transactions, registry.address);
    expect(redeem2ExitCode).toBe(0);

    // Trader 3 redeems outcome 0 (winning position)
    const redeem3Result = await redeemPositions(trader3, conditionId, [1n]);
    const redeem3ExitCode = getExitCode(redeem3Result.transactions, registry.address);
    expect(redeem3ExitCode).toBe(0);
  });
});
