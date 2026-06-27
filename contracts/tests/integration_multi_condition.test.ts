/**
 * Integration Tests: Multi-Condition Market
 *
 * Exercises a market with 2 conditions, each having 2 outcomes,
 * resulting in 4 atomic outcomes (cartesian product):
 *   [BTC-Yes + ETH-Yes, BTC-Yes + ETH-No, BTC-No + ETH-Yes, BTC-No + ETH-No]
 *
 * Condition 1: "Will BTC > $100k?" (Yes/No)
 * Condition 2: "Will ETH > $10k?" (Yes/No)
 *
 * Flow: deploy → prepare 2 conditions → init MM with both → buy → sell → resolve both → verify
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
} from '../../wrappers-ts/ConditionRegistry.gen';
import {
  LmsrMarketMaker,
  MarketOpCodes,
  MarketErrors,
  MarketStorage,
  marketStorageToCell,
  buildTradePayload,
  buildSellTrade,
  STAGE_RUNNING,
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

describe('Integration: Multi-Condition Market (2 conditions, 4 atomic outcomes)', () => {
  let blockchain: Blockchain;
  let registry: SandboxContract<ConditionRegistry>;
  let mm: SandboxContract<LmsrMarketMaker>;
  let deployer: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let trader: SandboxContract<TreasuryContract>;
  let jettonMaster: SandboxContract<TreasuryContract>;
  let registryJettonWallet: Address;
  let mmJettonWallet: Address;
  let registryCode: Cell;
  let mmCode: Cell;

  // Condition 1: "Will BTC > $100k?" (Yes/No)
  const questionId1 = 1n;
  const outcomeSlotCount1 = 2;

  // Condition 2: "Will ETH > $10k?" (Yes/No)
  const questionId2 = 2n;
  const outcomeSlotCount2 = 2;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    oracle = await blockchain.treasury('oracle');
    trader = await blockchain.treasury('trader');
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
      { owner: deployer.address, jettonWallet: registryJettonWallet },
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
  async function prepareCondition(questionId: bigint, outcomeSlotCount: number): Promise<bigint> {
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
   * Initialize the Market Maker with funding and multiple conditions.
   */
  async function initMarketMaker(params: {
    conditionIds: bigint[];
    outcomeSlotCounts: number[];
    funding: bigint;
  }) {
    const initPayload = buildInitMarketPayload({
      conditionRegistry: registry.address,
      conditionIds: params.conditionIds,
      outcomeSlotCounts: params.outcomeSlotCounts,
    });

    const transferNotification = buildTransferNotification({
      amount: params.funding,
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
   * Execute a buy trade via the Market Maker with 4-element outcome amounts array.
   */
  async function executeBuyTrade(params: {
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
      sender: trader.address,
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
   * Execute a sell trade via the Market Maker.
   */
  async function executeSellTrade(params: {
    outcomeTokenAmounts: bigint[];
    minCollateralReturn: bigint;
  }) {
    return await mm.sendSellTrade(
      trader.getSender(),
      toNano('0.2'),
      {
        outcomeTokenAmounts: params.outcomeTokenAmounts,
        minCollateralReturn: params.minCollateralReturn,
      },
    );
  }

  /**
   * Oracle resolves a condition.
   */
  async function resolveCondition(questionId: bigint, payouts: bigint[]) {
    return await registry.sendReportPayouts(
      oracle.getSender(),
      toNano('0.2'),
      {
        questionId,
        payouts,
      },
    );
  }

  // ─── Main Integration Test ────────────────────────────────────────────────

  it('should complete multi-condition lifecycle: prepare 2 conditions → init MM → buy → sell → resolve both', async () => {
    // ═══ Step 1: Prepare both conditions on the registry ═══
    // Condition 1: "Will BTC > $100k?" (Yes/No)
    const conditionId1 = await prepareCondition(questionId1, outcomeSlotCount1);

    // Verify condition 1 exists
    const condition1 = await registry.getCondition(conditionId1);
    expect(condition1.outcomeSlotCount).toBe(outcomeSlotCount1);
    expect(condition1.payoutDenominator).toBe(0n); // Not yet resolved

    // Condition 2: "Will ETH > $10k?" (Yes/No)
    const conditionId2 = await prepareCondition(questionId2, outcomeSlotCount2);

    // Verify condition 2 exists
    const condition2 = await registry.getCondition(conditionId2);
    expect(condition2.outcomeSlotCount).toBe(outcomeSlotCount2);
    expect(condition2.payoutDenominator).toBe(0n); // Not yet resolved

    // ═══ Step 2: Initialize Market Maker with BOTH conditions ═══
    // outcomeSlotCounts = [2, 2] → atomicOutcomeSlotCount = 2 × 2 = 4
    const funding = 10000n;
    const initResult = await initMarketMaker({
      conditionIds: [conditionId1, conditionId2],
      outcomeSlotCounts: [outcomeSlotCount1, outcomeSlotCount2],
      funding,
    });
    const initExitCode = getExitCode(initResult.transactions, mm.address);
    expect(initExitCode).toBe(0);

    // Verify MM is now running with correct funding
    const stage = await mm.getStage();
    expect(stage).toBe(STAGE_RUNNING);

    const storedFunding = await mm.getFunding();
    expect(storedFunding).toBe(funding);

    // ═══ Step 3: Verify atomicOutcomeSlotCount = 4 ═══
    // We verify this implicitly: a trade with 4-element array should succeed,
    // whereas a 2-element array would fail (InvalidTradeAmounts).
    // The successful buy below confirms the MM has 4 atomic outcomes.

    // ═══ Step 4: Execute a buy trade with 4-element outcome amounts ═══
    // Buy "BTC-Yes + ETH-Yes" (atomic outcome index 0)
    // The 4 atomic outcomes are:
    //   [0] BTC-Yes + ETH-Yes
    //   [1] BTC-Yes + ETH-No
    //   [2] BTC-No + ETH-Yes
    //   [3] BTC-No + ETH-No
    const buyResult = await executeBuyTrade({
      collateralAmount: 5000n,
      outcomeTokenAmounts: [10n, 0n, 0n, 0n], // Buy 10 units of atomic outcome 0
      collateralLimit: 0n, // No limit
    });
    const buyExitCode = getExitCode(buyResult.transactions, mm.address);
    expect(buyExitCode).toBe(0);

    // ═══ Step 5: Execute a sell trade ═══
    // Sell some of what we bought (partial sell of outcome 0)
    const sellResult = await executeSellTrade({
      outcomeTokenAmounts: [5n, 0n, 0n, 0n], // Sell 5 units of atomic outcome 0
      minCollateralReturn: 0n, // No minimum
    });
    const sellExitCode = getExitCode(sellResult.transactions, mm.address);
    expect(sellExitCode).toBe(0);

    // ═══ Step 6: Oracle resolves both conditions ═══
    // Condition 1: BTC-Yes wins (payout = [1, 0])
    const resolve1Result = await resolveCondition(questionId1, [1n, 0n]);
    const resolve1ExitCode = getExitCode(resolve1Result.transactions, registry.address);
    expect(resolve1ExitCode).toBe(0);

    // Condition 2: ETH-No wins (payout = [0, 1])
    const resolve2Result = await resolveCondition(questionId2, [0n, 1n]);
    const resolve2ExitCode = getExitCode(resolve2Result.transactions, registry.address);
    expect(resolve2ExitCode).toBe(0);

    // ═══ Step 7: Verify resolutions were stored correctly ═══
    const resolvedCondition1 = await registry.getCondition(conditionId1);
    expect(resolvedCondition1.payoutDenominator).toBeGreaterThan(0n);

    const resolvedCondition2 = await registry.getCondition(conditionId2);
    expect(resolvedCondition2.payoutDenominator).toBeGreaterThan(0n);
  });
});
