/**
 * Integration Tests: Full Prediction Market Lifecycle
 *
 * Exercises the complete flow across both Condition Registry and LMSR Market Maker:
 *   prepare condition → split collateral → trade via AMM → resolve → redeem
 *
 * Both contracts are deployed on the same blockchain instance to simulate
 * real end-to-end interactions.
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

describe('Integration: Full Lifecycle', () => {
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

  const questionId = 1n; // "Will BTC > $100k?"
  const outcomeSlotCount = 2; // Binary: Yes/No

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
   * Step 1: Prepare a condition on the registry.
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
   * Step 2: Initialize the Market Maker with funding.
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
   * Step 3: Split collateral into positions via the Condition Registry.
   */
  async function splitCollateral(conditionId: bigint, amount: bigint) {
    const splitPayload = buildSplitPositionPayload({
      collateralToken: jettonMaster.address,
      parentCollectionId: 0n,
      conditionId,
      partition: [1n, 2n], // Full partition for 2-outcome: [Yes, No]
    });

    const transferNotification = buildTransferNotification({
      amount,
      sender: trader.address,
      forwardPayload: splitPayload,
    });

    const msg: TonMessage = {
      info: {
        type: 'internal',
        ihrDisabled: true,
        bounce: true,
        bounced: false,
        src: registryJettonWallet,
        dest: registry.address,
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
   * Step 4: Execute a buy trade via the Market Maker.
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
   * Step 5: Oracle resolves the condition.
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
   * Step 6: Redeem positions to recover collateral.
   */
  async function redeemPositions(conditionId: bigint, indexSets: bigint[]) {
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

  it('should complete full lifecycle: prepare → split → trade → resolve → redeem', async () => {
    // ═══ Step 1: Prepare a condition ═══
    // Create a binary condition: "Will BTC > $100k?"
    const conditionId = await prepareCondition();

    // Verify condition exists via get-method
    const condition = await registry.getCondition(conditionId);
    expect(condition.outcomeSlotCount).toBe(outcomeSlotCount);
    expect(condition.payoutDenominator).toBe(0n); // Not yet resolved

    // ═══ Step 2: Initialize Market Maker ═══
    const funding = 1000n;
    const initResult = await initMarketMaker(conditionId, funding);
    const initExitCode = getExitCode(initResult.transactions, mm.address);
    expect(initExitCode).toBe(0);

    // Verify MM is now running with correct funding
    const stage = await mm.getStage();
    expect(stage).toBe(STAGE_RUNNING);

    const storedFunding = await mm.getFunding();
    expect(storedFunding).toBe(funding);

    // ═══ Step 3: Split collateral into positions ═══
    const splitAmount = 500n;
    const splitResult = await splitCollateral(conditionId, splitAmount);
    const splitExitCode = getExitCode(splitResult.transactions, registry.address);
    expect(splitExitCode).toBe(0);

    // ═══ Step 4: Execute a buy trade via AMM ═══
    // Buy 10 units of outcome 0 (Yes) — trader is betting BTC > $100k
    const tradeResult = await executeBuyTrade({
      collateralAmount: 500n,
      outcomeTokenAmounts: [10n, 0n],
      collateralLimit: 0n, // No limit
    });
    const tradeExitCode = getExitCode(tradeResult.transactions, mm.address);
    expect(tradeExitCode).toBe(0);

    // ═══ Step 5: Oracle resolves the condition ═══
    // Outcome 0 (Yes) wins: BTC did exceed $100k
    const resolveResult = await resolveCondition([1n, 0n]);
    const resolveExitCode = getExitCode(resolveResult.transactions, registry.address);
    expect(resolveExitCode).toBe(0);

    // Verify condition is now resolved
    const resolvedCondition = await registry.getCondition(conditionId);
    expect(resolvedCondition.payoutDenominator).toBeGreaterThan(0n);

    // ═══ Step 6: Redeem winning positions ═══
    // Trader redeems the winning outcome (indexSet=1, outcome 0)
    const redeemResult = await redeemPositions(conditionId, [1n]);
    const redeemExitCode = getExitCode(redeemResult.transactions, registry.address);
    expect(redeemExitCode).toBe(0);
  });
});
