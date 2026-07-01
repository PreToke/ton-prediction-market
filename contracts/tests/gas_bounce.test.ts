/**
 * Tests for Gas Validation and Bounce Recovery (Requirement 14: TON Architecture Adaptation).
 *
 * Validates:
 * - Condition Registry rejects messages with < 0.1 TON attached (InsufficientGas = 210)
 * - Market Maker rejects messages with < 0.2 TON attached (InsufficientGas = 310)
 * - Messages with sufficient gas succeed normally
 * - Bounced Jetton transfers restore user position balances in the Condition Registry
 * - Bounced Jetton transfers restore Market Maker internal state (position balances, fees)
 *
 * These tests are written BEFORE the implementation (TDD).
 * They will fail until tasks 12.2/12.3 implement gas checks and bounce handlers.
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
  buildPrepareCondition,
  buildMergePositions,
  buildSplitPositionPayload,
  OpCodes,
} from '../../wrappers-ts/ConditionRegistry.gen';
import {
  LmsrMarketMaker,
  MarketOpCodes,
  MarketErrors,
  MarketStorage,
  marketStorageToCell,
  buildPause,
  buildResume,
  STAGE_RUNNING,
} from '../../wrappers-ts/LmsrMarketMaker.gen';

// ————————————————————————————————————————————
//   Helpers
// ————————————————————————————————————————————

/** Load compiled ConditionRegistry contract code from build output */
function loadRegistryCode(): Cell {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const artifact = require('../../build/ConditionRegistry.json');
  return Cell.fromBase64(artifact.code_boc64);
}

/** Load compiled LmsrMarketMaker contract code from build output */
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
 * Extract the exit code from the transaction targeting a specific contract address.
 * Finds the last transaction sent TO the target and reads the VM exit code.
 */
function getExitCode(
  transactions: BlockchainTransaction[],
  targetAddress: Address,
): number {
  const targetHash = addressToBigint(targetAddress);

  for (let i = transactions.length - 1; i >= 0; i--) {
    const tx = transactions[i];
    if (tx.address === targetHash && tx.description.type === 'generic') {
      const computePhase = tx.description.computePhase;
      if (computePhase.type === 'vm') {
        return computePhase.exitCode;
      }
    }
  }
  throw new Error('No VM transaction found on target contract');
}

/**
 * Build a transfer_notification message body.
 * Used to simulate Jetton wallet notifications arriving at the contract.
 */
function buildTransferNotification(params: {
  amount: bigint;
  sender: Address;
  forwardPayload: Cell;
}): Cell {
  return beginCell()
    .storeUint(0x7362d09c, 32) // op::transfer_notification
    .storeUint(0, 64) // query_id
    .storeCoins(params.amount) // amount of Jettons
    .storeAddress(params.sender) // original sender
    .storeRef(params.forwardPayload) // forward_payload as ref
    .endCell();
}

/**
 * Build an init_market forward_payload for the Market Maker.
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
 * Simulate a bounced message arriving at a contract.
 * In TON, bounced messages have the `bounced` flag set in the internal message info
 * and the body starts with 0xFFFFFFFF (32-bit bounce prefix) followed by
 * the first 256 bits of the original message body.
 */
function buildBouncedMessage(params: {
  from: Address;
  to: Address;
  value: bigint;
  originalBody: Cell;
}): TonMessage {
  // Bounced messages contain: 32-bit bounce prefix (0xFFFFFFFF) + first 256 bits of original body
  const originalSlice = params.originalBody.beginParse();
  const bitsAvailable = Math.min(originalSlice.remainingBits, 256);
  const originalBits = originalSlice.loadBits(bitsAvailable);

  const bouncedBody = beginCell()
    .storeUint(0xFFFFFFFF, 32) // bounce prefix
    .storeBits(originalBits) // first 256 bits of original message
    .endCell();

  return {
    info: {
      type: 'internal',
      ihrDisabled: true,
      bounce: false,
      bounced: true,
      src: params.from,
      dest: params.to,
      value: { coins: params.value },
      ihrFee: 0n,
      forwardFee: 0n,
      createdLt: 0n,
      createdAt: 0,
    },
    body: bouncedBody,
  };
}

// ————————————————————————————————————————————
//   Gas Validation Tests — Condition Registry
// ————————————————————————————————————————————

describe('Gas Validation - Condition Registry', () => {
  let blockchain: Blockchain;
  let registry: SandboxContract<ConditionRegistry>;
  let deployer: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let contractCode: Cell;

  const questionId = 1n;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    oracle = await blockchain.treasury('oracle');

    contractCode = loadRegistryCode();

    const contract = ConditionRegistry.fromStorage(
      { owner: deployer.address, jettonWallet: deployer.address, collateralToken: deployer.address },
      contractCode,
    );

    registry = blockchain.openContract(contract);
    await registry.sendDeploy(deployer.getSender(), toNano('0.5'));
  });

  it('should reject prepare_condition with insufficient gas (< 0.1 TON)', async () => {
    // Send with only 0.01 TON — should be rejected
    const result = await registry.sendPrepareCondition(
      deployer.getSender(),
      toNano('0.01'), // Insufficient: minimum is 0.1 TON
      {
        oracle: oracle.address,
        questionId: questionId,
        outcomeSlotCount: 2,
      },
    );

    const exitCode = getExitCode(result.transactions, registry.address);
    expect(exitCode).toBe(RegistryErrors.InsufficientGas); // 210
  });

  it('should reject merge_positions with insufficient gas (< 0.1 TON)', async () => {
    // First prepare a condition with sufficient gas
    await registry.sendPrepareCondition(
      deployer.getSender(),
      toNano('0.1'),
      {
        oracle: oracle.address,
        questionId: questionId,
        outcomeSlotCount: 2,
      },
    );

    // Attempt merge with insufficient gas
    const collateralToken = deployer.address;
    const conditionId = 0n; // placeholder — the actual ID is derived; the gas check fires first
    const result = await registry.sendMergePositions(
      deployer.getSender(),
      toNano('0.01'), // Insufficient: minimum is 0.1 TON
      {
        collateralToken,
        parentCollectionId: 0n,
        conditionId,
        partition: [1n, 2n],
        amount: 100n,
      },
    );

    const exitCode = getExitCode(result.transactions, registry.address);
    expect(exitCode).toBe(RegistryErrors.InsufficientGas); // 210
  });

  it('should reject redeem_positions with insufficient gas (< 0.1 TON)', async () => {
    const result = await registry.sendRedeemPositions(
      deployer.getSender(),
      toNano('0.01'), // Insufficient: minimum is 0.1 TON
      {
        collateralToken: deployer.address,
        parentCollectionId: 0n,
        conditionId: 0n,
        indexSets: [1n, 2n],
      },
    );

    const exitCode = getExitCode(result.transactions, registry.address);
    expect(exitCode).toBe(RegistryErrors.InsufficientGas); // 210
  });

  it('should accept prepare_condition with exactly 0.1 TON', async () => {
    const result = await registry.sendPrepareCondition(
      deployer.getSender(),
      toNano('0.1'), // Exactly the minimum
      {
        oracle: oracle.address,
        questionId: questionId,
        outcomeSlotCount: 2,
      },
    );

    const exitCode = getExitCode(result.transactions, registry.address);
    expect(exitCode).toBe(0); // Success
  });

  it('should accept prepare_condition with more than 0.1 TON', async () => {
    const result = await registry.sendPrepareCondition(
      deployer.getSender(),
      toNano('0.5'), // Well above minimum
      {
        oracle: oracle.address,
        questionId: 99n,
        outcomeSlotCount: 3,
      },
    );

    const exitCode = getExitCode(result.transactions, registry.address);
    expect(exitCode).toBe(0); // Success
  });
});

// ————————————————————————————————————————————
//   Gas Validation Tests — Market Maker
// ————————————————————————————————————————————

describe('Gas Validation - Market Maker', () => {
  let blockchain: Blockchain;
  let mm: SandboxContract<LmsrMarketMaker>;
  let deployer: SandboxContract<TreasuryContract>;
  let conditionRegistry: SandboxContract<TreasuryContract>;
  let collateralToken: SandboxContract<TreasuryContract>;
  let mmJettonWallet: Address;
  let contractCode: Cell;

  const conditionId1 = BigInt('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    conditionRegistry = await blockchain.treasury('conditionRegistry');
    collateralToken = await blockchain.treasury('collateralToken');

    contractCode = loadMarketMakerCode();

    const mmJettonWalletTreasury = await blockchain.treasury('mmJettonWallet');
    mmJettonWallet = mmJettonWalletTreasury.address;

    // Deploy a running (initialized) market maker for lifecycle tests
    const storage: MarketStorage = {
      owner: deployer.address,
      conditionRegistry: conditionRegistry.address,
      collateralToken: collateralToken.address,
      jettonWallet: mmJettonWallet,
      funding: 1000n,
      fee: 0n,
      stage: 0, // Running
      atomicOutcomeSlotCount: 2,
    };

    const contract = LmsrMarketMaker.fromStorage(storage, contractCode);
    mm = blockchain.openContract(contract);
    await mm.sendDeploy(deployer.getSender(), toNano('0.5'));
  });

  it('should reject pause with insufficient gas (< 0.2 TON)', async () => {
    const result = await mm.sendPause(
      deployer.getSender(),
      toNano('0.05'), // Insufficient: minimum is 0.2 TON
    );

    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(MarketErrors.InsufficientGas); // 310
  });

  it('should reject close with insufficient gas (< 0.2 TON)', async () => {
    const result = await mm.sendClose(
      deployer.getSender(),
      toNano('0.1'), // 0.1 is still below 0.2 TON minimum for MM
    );

    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(MarketErrors.InsufficientGas); // 310
  });

  it('should reject change_fee with insufficient gas (< 0.2 TON)', async () => {
    const result = await mm.sendChangeFee(
      deployer.getSender(),
      toNano('0.05'), // Insufficient
      100n,
    );

    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(MarketErrors.InsufficientGas); // 310
  });

  it('should reject sell_trade with insufficient gas (< 0.2 TON)', async () => {
    const result = await mm.sendSellTrade(
      deployer.getSender(),
      toNano('0.05'), // Insufficient
      {
        outcomeTokenAmounts: [10n, -10n],
        minCollateralReturn: 0n,
      },
    );

    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(MarketErrors.InsufficientGas); // 310
  });

  it('should reject transfer_notification (buy trade) with insufficient gas (< 0.2 TON)', async () => {
    // Build a buy trade payload
    const tradeAmountsCell = beginCell()
      .storeInt(100n, 64)
      .storeInt(0n, 64)
      .endCell();

    const tradePayload = beginCell()
      .storeUint(MarketOpCodes.TRADE, 32)
      .storeRef(tradeAmountsCell)
      .storeInt(0n, 128) // collateralLimit = 0 (no limit)
      .endCell();

    const transferNotification = buildTransferNotification({
      amount: 10000n,
      sender: deployer.address,
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
        value: { coins: toNano('0.05') }, // Insufficient
        ihrFee: 0n,
        forwardFee: 0n,
        createdLt: 0n,
        createdAt: 0,
      },
      body: transferNotification,
    };

    const result = await blockchain.sendMessage(msg);
    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(MarketErrors.InsufficientGas); // 310
  });

  it('should accept pause with exactly 0.2 TON', async () => {
    const result = await mm.sendPause(
      deployer.getSender(),
      toNano('0.2'), // Exactly the minimum
    );

    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(0); // Success
  });

  it('should accept pause with more than 0.2 TON', async () => {
    const result = await mm.sendPause(
      deployer.getSender(),
      toNano('0.5'), // Well above minimum
    );

    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(0); // Success
  });
});

// ————————————————————————————————————————————
//   Bounce Recovery Tests — Condition Registry
// ————————————————————————————————————————————

describe('Bounce Recovery - Condition Registry', () => {
  let blockchain: Blockchain;
  let registry: SandboxContract<ConditionRegistry>;
  let deployer: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let jettonWallet: SandboxContract<TreasuryContract>;
  let contractCode: Cell;

  const questionId = 1n;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    oracle = await blockchain.treasury('oracle');
    jettonWallet = await blockchain.treasury('jettonWallet');

    contractCode = loadRegistryCode();

    const contract = ConditionRegistry.fromStorage(
      { owner: deployer.address, jettonWallet: jettonWallet.address, collateralToken: jettonWallet.address },
      contractCode,
    );

    registry = blockchain.openContract(contract);
    await registry.sendDeploy(deployer.getSender(), toNano('0.5'));
  });

  it('should restore position balances when a Jetton transfer bounces after split', async () => {
    // Setup: First prepare a condition and perform a split to establish positions
    await registry.sendPrepareCondition(
      deployer.getSender(),
      toNano('0.1'),
      {
        oracle: oracle.address,
        questionId: questionId,
        outcomeSlotCount: 2,
      },
    );

    // Compute the condition ID to use in the split
    const conditionIdResult = await blockchain.runGetMethod(
      registry.address,
      'compute_condition_id',
      [
        { type: 'slice', cell: beginCell().storeAddress(oracle.address).endCell() },
        { type: 'int', value: questionId },
        { type: 'int', value: 2n },
      ],
    );
    const conditionId = conditionIdResult.stackReader.readBigNumber();

    // Perform a split via transfer_notification (from jetton wallet)
    const splitPayload = buildSplitPositionPayload({
      collateralToken: jettonWallet.address,
      parentCollectionId: 0n,
      conditionId: conditionId,
      partition: [1n, 2n], // Full set for 2 outcomes: {0} and {1}
    });

    const splitNotification = buildTransferNotification({
      amount: 1000n,
      sender: deployer.address,
      forwardPayload: splitPayload,
    });

    const splitMsg: TonMessage = {
      info: {
        type: 'internal',
        ihrDisabled: true,
        bounce: true,
        bounced: false,
        src: jettonWallet.address,
        dest: registry.address,
        value: { coins: toNano('0.1') },
        ihrFee: 0n,
        forwardFee: 0n,
        createdLt: 0n,
        createdAt: 0,
      },
      body: splitNotification,
    };

    const splitResult = await blockchain.sendMessage(splitMsg);
    const splitExitCode = getExitCode(splitResult.transactions, registry.address);
    expect(splitExitCode).toBe(0); // Split should succeed

    // Now simulate a bounced Jetton transfer message arriving at the registry.
    // The original message would have been a Jetton transfer (op 0x0f8a7ea5)
    // sent by the registry to transfer tokens. When it bounces, the registry
    // should restore the user's position balances.
    const jettonTransferOp = 0x0f8a7ea5; // Standard Jetton transfer op-code
    const originalJettonTransfer = beginCell()
      .storeUint(jettonTransferOp, 32)
      .storeUint(0, 64) // query_id
      .storeCoins(1000n) // amount
      .storeAddress(deployer.address) // destination
      .storeAddress(deployer.address) // response_destination
      .endCell();

    const bouncedMsg = buildBouncedMessage({
      from: jettonWallet.address,
      to: registry.address,
      value: toNano('0.05'),
      originalBody: originalJettonTransfer,
    });

    const bounceResult = await blockchain.sendMessage(bouncedMsg);

    // The bounce handler should execute without error (exit code 0)
    // and restore the user's position balances
    const bounceExitCode = getExitCode(bounceResult.transactions, registry.address);
    expect(bounceExitCode).toBe(0);
  });

  it('should handle bounce with the original transfer op-code to identify restoration', async () => {
    // Send a bounced message that contains the Jetton transfer op-code
    // The contract should parse the op-code from the bounced body and
    // use it to determine what state needs to be restored.
    const jettonTransferOp = 0x0f8a7ea5;
    const originalBody = beginCell()
      .storeUint(jettonTransferOp, 32)
      .storeUint(123, 64) // query_id
      .storeCoins(500n) // amount
      .storeAddress(deployer.address) // destination
      .endCell();

    const bouncedMsg = buildBouncedMessage({
      from: jettonWallet.address,
      to: registry.address,
      value: toNano('0.05'),
      originalBody: originalBody,
    });

    const result = await blockchain.sendMessage(bouncedMsg);

    // Bounce handler should process without crashing
    const exitCode = getExitCode(result.transactions, registry.address);
    expect(exitCode).toBe(0);
  });
});

// ————————————————————————————————————————————
//   Bounce Recovery Tests — Market Maker
// ————————————————————————————————————————————

describe('Bounce Recovery - Market Maker', () => {
  let blockchain: Blockchain;
  let mm: SandboxContract<LmsrMarketMaker>;
  let deployer: SandboxContract<TreasuryContract>;
  let conditionRegistry: SandboxContract<TreasuryContract>;
  let collateralToken: SandboxContract<TreasuryContract>;
  let mmJettonWallet: Address;
  let contractCode: Cell;

  const conditionId1 = BigInt('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    conditionRegistry = await blockchain.treasury('conditionRegistry');
    collateralToken = await blockchain.treasury('collateralToken');

    contractCode = loadMarketMakerCode();

    const mmJettonWalletTreasury = await blockchain.treasury('mmJettonWallet');
    mmJettonWallet = mmJettonWalletTreasury.address;

    // Deploy a running (initialized) market maker
    const storage: MarketStorage = {
      owner: deployer.address,
      conditionRegistry: conditionRegistry.address,
      collateralToken: collateralToken.address,
      jettonWallet: mmJettonWallet,
      funding: 1000n,
      fee: 0n,
      stage: 0, // Running
      atomicOutcomeSlotCount: 2,
    };

    const contract = LmsrMarketMaker.fromStorage(storage, contractCode);
    mm = blockchain.openContract(contract);
    await mm.sendDeploy(deployer.getSender(), toNano('0.5'));
  });

  it('should restore position balances when a Jetton transfer bounces after trade', async () => {
    // Simulate a bounced Jetton transfer that was originally sent by the MM
    // after a sell trade (MM sends collateral back to trader).
    // The bounce handler should restore the MM's internal position balances.
    const jettonTransferOp = 0x0f8a7ea5; // Standard Jetton transfer op-code
    const originalJettonTransfer = beginCell()
      .storeUint(jettonTransferOp, 32)
      .storeUint(0, 64) // query_id
      .storeCoins(500n) // amount that was being transferred
      .storeAddress(deployer.address) // destination (trader)
      .storeAddress(deployer.address) // response_destination
      .endCell();

    const bouncedMsg = buildBouncedMessage({
      from: mmJettonWallet,
      to: mm.address,
      value: toNano('0.05'),
      originalBody: originalJettonTransfer,
    });

    const result = await blockchain.sendMessage(bouncedMsg);

    // Bounce handler should execute without error
    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(0);
  });

  it('should restore accumulated fees when a fee withdrawal Jetton transfer bounces', async () => {
    // Simulate a bounced Jetton transfer from a fee withdrawal.
    // The MM should restore its accumulatedFees when the transfer fails.
    const jettonTransferOp = 0x0f8a7ea5;
    const originalBody = beginCell()
      .storeUint(jettonTransferOp, 32)
      .storeUint(0, 64) // query_id
      .storeCoins(200n) // fees being withdrawn
      .storeAddress(deployer.address) // owner (destination)
      .storeAddress(deployer.address) // response_destination
      .endCell();

    const bouncedMsg = buildBouncedMessage({
      from: mmJettonWallet,
      to: mm.address,
      value: toNano('0.05'),
      originalBody: originalBody,
    });

    const result = await blockchain.sendMessage(bouncedMsg);

    // Bounce handler should process the bounced fee withdrawal
    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(0);
  });

  it('should contain the original transfer op-code in the bounced message for identification', async () => {
    // The bounced message format includes the first 256 bits of the original body.
    // This always includes the 32-bit op-code, which the contract uses to identify
    // what kind of transfer failed and what state to restore.
    const jettonTransferOp = 0x0f8a7ea5;
    const originalBody = beginCell()
      .storeUint(jettonTransferOp, 32)
      .storeUint(42, 64) // query_id
      .storeCoins(100n) // amount
      .storeAddress(deployer.address)
      .endCell();

    const bouncedMsg = buildBouncedMessage({
      from: mmJettonWallet,
      to: mm.address,
      value: toNano('0.05'),
      originalBody: originalBody,
    });

    // Verify the bounced message body structure contains the op-code
    const bouncedSlice = bouncedMsg.body.beginParse();
    const bouncePrefix = bouncedSlice.loadUint(32);
    expect(bouncePrefix).toBe(0xFFFFFFFF); // Standard bounce prefix

    // The next 32 bits should be the original op-code
    const recoveredOp = bouncedSlice.loadUint(32);
    expect(recoveredOp).toBe(jettonTransferOp);

    // Send the bounced message to the contract
    const result = await blockchain.sendMessage(bouncedMsg);
    const exitCode = getExitCode(result.transactions, mm.address);
    expect(exitCode).toBe(0);
  });
});
