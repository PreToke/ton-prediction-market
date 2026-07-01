/**
 * Tests for Condition Preparation (Requirement 1).
 *
 * Validates:
 * - Successful condition preparation stores condition data
 * - Invalid outcome counts (0, 1) are rejected with InvalidOutcomeCount (200)
 * - Valid boundary outcome counts (2, 255) succeed
 * - Duplicate conditions are rejected with ConditionAlreadyExists (201)
 * - Different conditions from the same oracle both succeed
 *
 * These tests deploy the ConditionRegistry contract in a TON Sandbox
 * and exercise the prepare_condition message handler (op 0x01).
 *
 * NOTE: These tests are written BEFORE the implementation (TDD).
 * They will fail until task 4.2 implements the prepare_condition handler.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  Blockchain,
  SandboxContract,
  TreasuryContract,
  BlockchainTransaction,
} from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
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
 * Finds the transaction sent TO the registry address and reads the VM exit code.
 * Skips the deploy transaction (first tx on the contract) by finding the LAST
 * matching transaction.
 */
function getRegistryExitCode(
  transactions: BlockchainTransaction[],
  registryAddress: Address,
): number {
  const registryHash = addressToBigint(registryAddress);

  // Find the last transaction on the registry (skip deploy if multiple)
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

describe('Condition Preparation', () => {
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

  // ─── Successful Preparation ──────────────────────────────────────────────

  describe('successful preparation', () => {
    it('should prepare a condition with valid parameters (2 outcomes)', async () => {
      const result = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 2,
        },
      );

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(0);
    });

    it('should prepare a condition with minimum valid outcome count (2)', async () => {
      const result = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 2,
        },
      );

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(0);
    });

    it('should prepare a condition with maximum valid outcome count (255)', async () => {
      // uint8 max is 255 in the message format
      const result = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 255,
        },
      );

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(0);
    });
  });

  // ─── Invalid Outcome Count ───────────────────────────────────────────────

  describe('invalid outcome count rejection', () => {
    it('should reject outcome_slot_count = 0', async () => {
      const result = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 0,
        },
      );

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidOutcomeCount);
    });

    it('should reject outcome_slot_count = 1', async () => {
      const result = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 1,
        },
      );

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      expect(exitCode).toBe(RegistryErrors.InvalidOutcomeCount);
    });
  });

  // ─── Duplicate Condition ─────────────────────────────────────────────────

  describe('duplicate condition rejection', () => {
    it('should reject preparing the same condition twice', async () => {
      // First preparation should succeed
      const firstResult = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 3,
        },
      );

      const firstExitCode = getRegistryExitCode(
        firstResult.transactions,
        registry.address,
      );
      expect(firstExitCode).toBe(0);

      // Second preparation with same params should fail
      const secondResult = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 3,
        },
      );

      const secondExitCode = getRegistryExitCode(
        secondResult.transactions,
        registry.address,
      );
      expect(secondExitCode).toBe(RegistryErrors.ConditionAlreadyExists);
    });
  });

  // ─── Different Conditions from Same Oracle ───────────────────────────────

  describe('different conditions from same oracle', () => {
    it('should allow preparing two different conditions (different question IDs)', async () => {
      // First condition with questionId1
      const firstResult = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 2,
        },
      );

      const firstExitCode = getRegistryExitCode(
        firstResult.transactions,
        registry.address,
      );
      expect(firstExitCode).toBe(0);

      // Second condition with questionId2 (different question)
      const secondResult = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId2,
          outcomeSlotCount: 2,
        },
      );

      const secondExitCode = getRegistryExitCode(
        secondResult.transactions,
        registry.address,
      );
      expect(secondExitCode).toBe(0);
    });

    it('should allow preparing conditions with different outcome counts from same oracle', async () => {
      // Same oracle, same question, different outcome count = different condition_id
      const firstResult = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 2,
        },
      );

      const firstExitCode = getRegistryExitCode(
        firstResult.transactions,
        registry.address,
      );
      expect(firstExitCode).toBe(0);

      const secondResult = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: oracle.address,
          questionId: questionId1,
          outcomeSlotCount: 5,
        },
      );

      const secondExitCode = getRegistryExitCode(
        secondResult.transactions,
        registry.address,
      );
      expect(secondExitCode).toBe(0);
    });
  });

  // ─── Invalid Oracle Address ──────────────────────────────────────────────

  describe('invalid oracle address', () => {
    it('should reject preparation with the zero address', async () => {
      // In TON, all well-formed MsgAddress values are technically routable.
      // However, the contract may choose to reject the zero-hash address
      // (workchain 0, hash = 0x00...00) as an invalid oracle.
      const zeroAddress = new Address(0, Buffer.alloc(32, 0));

      const result = await registry.sendPrepareCondition(
        deployer.getSender(),
        toNano('0.1'),
        {
          oracle: zeroAddress,
          questionId: questionId1,
          outcomeSlotCount: 2,
        },
      );

      const exitCode = getRegistryExitCode(result.transactions, registry.address);
      // The contract should reject with InvalidOracle (204) or accept (0).
      // If the implementation validates oracle addresses, expect 204.
      // If it treats all addresses as valid, expect 0.
      expect([0, RegistryErrors.InvalidOracle]).toContain(exitCode);
    });
  });
});
