/**
 * Tests for Condition Resolution (Requirement 2).
 *
 * Validates:
 * - Successful resolution stores payouts and computes denominator
 * - Wrong oracle is rejected (condition_id mismatch → ConditionNotFound 202)
 * - Unprepared condition is rejected with ConditionNotFound (202)
 * - Already resolved condition is rejected with ConditionAlreadyResolved (203)
 * - All-zero payouts are rejected with AllZeroPayouts (205)
 * - Multi-outcome resolution computes correct denominator
 * - Binary outcome resolution computes correct denominator
 *
 * These tests deploy the ConditionRegistry contract in a TON Sandbox
 * and exercise the report_payouts message handler (op 0x02).
 *
 * NOTE: These tests are written BEFORE the implementation (TDD).
 * They will fail until task 5.2 implements the report_payouts handler.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  Blockchain,
  SandboxContract,
  TreasuryContract,
  BlockchainTransaction,
} from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import {
  ConditionRegistry,
  RegistryErrors,
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

// ————————————————————————————————————————————
//   Tests
// ————————————————————————————————————————————

describe('Condition Resolution', () => {
  let blockchain: Blockchain;
  let registry: SandboxContract<ConditionRegistry>;
  let deployer: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let contractCode: Cell;

  const questionId1 = 1n;
  const questionId2 = 2n;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    deployer = await blockchain.treasury('deployer');
    oracle = await blockchain.treasury('oracle');

    contractCode = loadContractCode();

    // Deploy ConditionRegistry with initial storage
    const contract = ConditionRegistry.fromStorage(
      { owner: deployer.address, jettonWallet: deployer.address, collateralToken: deployer.address },
      contractCode,
    );

    registry = blockchain.openContract(contract);

    // Deploy the contract by sending an empty message
    await registry.sendDeploy(deployer.getSender(), toNano('0.5'));
  });

  // ─── Successful Resolution ───────────────────────────────────────────────

  describe('successful resolution', () => {
    it('should resolve a prepared binary condition with payouts [1, 0]', async () => {
      // Prepare a 2-outcome condition with our oracle
      const prepResult = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 2,
        },
      );

      const prepExitCode = getRegistryExitCode(prepResult.transactions, registry.address);
      expect(prepExitCode).toBe(0);

      // Oracle sends report_payouts with payouts [1, 0]
      const resolveResult = await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId1,
          payouts: [1n, 0n],
        },
      );

      const resolveExitCode = getRegistryExitCode(resolveResult.transactions, registry.address);
      expect(resolveExitCode).toBe(0);
    });

    it('should resolve a binary condition and set denominator = 1', async () => {
      // Prepare condition
      await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 2,
        },
      );

      // Oracle resolves with payouts [1, 0] → denominator = 1
      await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId1,
          payouts: [1n, 0n],
        },
      );

      // Verify condition state via getter
      const condition = await registry.getCondition(
        // We need the condition_id — derived from (oracle, questionId, outcomeSlotCount)
        // Use the getter if available, or compute it ourselves
        await getConditionId(registry, oracle.address, questionId1, 2),
      );

      expect(condition.payoutDenominator).toBe(1n);
    });

    it('should resolve a 3-outcome condition with payouts [1, 2, 3] and denominator = 6', async () => {
      // Prepare a 3-outcome condition
      await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 3,
        },
      );

      // Oracle resolves with payouts [1, 2, 3] → denominator = 1+2+3 = 6
      const resolveResult = await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId1,
          payouts: [1n, 2n, 3n],
        },
      );

      const resolveExitCode = getRegistryExitCode(resolveResult.transactions, registry.address);
      expect(resolveExitCode).toBe(0);

      // Verify denominator via getter
      const conditionId = await getConditionId(registry, oracle.address, questionId1, 3);
      const condition = await registry.getCondition(conditionId);
      expect(condition.payoutDenominator).toBe(6n);
    });
  });

  // ─── Wrong Oracle ────────────────────────────────────────────────────────

  describe('wrong oracle rejection', () => {
    it('should reject report_payouts from a different sender than the designated oracle', async () => {
      // Prepare condition with oracle address
      await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 2,
        },
      );

      // A different address (deployer) tries to report payouts
      // Since condition_id = hash(sender, questionId, payoutCount),
      // using a different sender means the condition_id won't match → ConditionNotFound
      const wrongOracle = await blockchain.treasury('wrongOracle');
      const resolveResult = await registry.sendReportPayouts(
        wrongOracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId1,
          payouts: [1n, 0n],
        },
      );

      const resolveExitCode = getRegistryExitCode(resolveResult.transactions, registry.address);
      expect(resolveExitCode).toBe(RegistryErrors.ConditionNotFound);
    });
  });

  // ─── Unprepared Condition ────────────────────────────────────────────────

  describe('unprepared condition rejection', () => {
    it('should reject report_payouts for a condition that was never prepared', async () => {
      // Do NOT prepare any condition — just try to resolve directly
      const resolveResult = await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId1,
          payouts: [1n, 0n],
        },
      );

      const resolveExitCode = getRegistryExitCode(resolveResult.transactions, registry.address);
      expect(resolveExitCode).toBe(RegistryErrors.ConditionNotFound);
    });
  });

  // ─── Already Resolved ────────────────────────────────────────────────────

  describe('already resolved rejection', () => {
    it('should reject a second report_payouts for the same condition', async () => {
      // Prepare condition
      await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 2,
        },
      );

      // First resolution should succeed
      const firstResolve = await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId1,
          payouts: [1n, 0n],
        },
      );

      const firstExitCode = getRegistryExitCode(firstResolve.transactions, registry.address);
      expect(firstExitCode).toBe(0);

      // Second resolution should fail with ConditionAlreadyResolved
      const secondResolve = await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId1,
          payouts: [0n, 1n],
        },
      );

      const secondExitCode = getRegistryExitCode(secondResolve.transactions, registry.address);
      expect(secondExitCode).toBe(RegistryErrors.ConditionAlreadyResolved);
    });
  });

  // ─── All-Zero Payouts ────────────────────────────────────────────────────

  describe('all-zero payouts rejection', () => {
    it('should reject report_payouts with all-zero payout values [0, 0, 0]', async () => {
      // Prepare a 3-outcome condition
      await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 3,
        },
      );

      // Try to resolve with all-zero payouts
      const resolveResult = await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId1,
          payouts: [0n, 0n, 0n],
        },
      );

      const resolveExitCode = getRegistryExitCode(resolveResult.transactions, registry.address);
      expect(resolveExitCode).toBe(RegistryErrors.AllZeroPayouts);
    });

    it('should reject report_payouts with all-zero payout values [0, 0]', async () => {
      // Prepare a 2-outcome condition
      await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId2,
          outcomeSlotCount: 2,
        },
      );

      // Try to resolve with all-zero payouts
      const resolveResult = await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId2,
          payouts: [0n, 0n],
        },
      );

      const resolveExitCode = getRegistryExitCode(resolveResult.transactions, registry.address);
      expect(resolveExitCode).toBe(RegistryErrors.AllZeroPayouts);
    });
  });

  // ─── Multi-Outcome Resolution ───────────────────────────────────────────

  describe('multi-outcome resolution', () => {
    it('should resolve a 3-outcome condition and compute denominator as sum of payouts', async () => {
      // Prepare 3-outcome condition
      await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 3,
        },
      );

      // Resolve with payouts [1, 2, 3] → denominator = 6
      await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId1,
          payouts: [1n, 2n, 3n],
        },
      );

      const conditionId = await getConditionId(registry, oracle.address, questionId1, 3);
      const condition = await registry.getCondition(conditionId);
      expect(condition.payoutDenominator).toBe(6n);
    });

    it('should resolve with uneven payouts [5, 0, 3] and compute denominator = 8', async () => {
      // Prepare 3-outcome condition
      await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId2,
          outcomeSlotCount: 3,
        },
      );

      // Resolve with payouts [5, 0, 3] → denominator = 8
      await registry.sendReportPayouts(
        oracle.getSender(),
        toNano('0.1'),
        {
          questionId: questionId2,
          payouts: [5n, 0n, 3n],
        },
      );

      const conditionId = await getConditionId(registry, oracle.address, questionId2, 3);
      const condition = await registry.getCondition(conditionId);
      expect(condition.payoutDenominator).toBe(8n);
    });
  });
});

// ————————————————————————————————————————————
//   Helper: compute condition_id locally
// ————————————————————————————————————————————

/**
 * Compute the condition_id locally using the same derivation logic as the contract:
 * condition_id = hash(oracle_address || question_id || outcome_slot_count)
 *
 * This mirrors get_condition_id() in condition_registry.tolk.
 */
async function getConditionId(
  _registry: SandboxContract<ConditionRegistry>,
  oracleAddress: Address,
  questionId: bigint,
  outcomeSlotCount: number,
): Promise<bigint> {
  const cell = beginCell()
    .storeAddress(oracleAddress)
    .storeUint(questionId, 256)
    .storeUint(outcomeSlotCount, 8)
    .endCell();
  return BigInt('0x' + cell.hash().toString('hex'));
}
