/**
 * Test setup and shared utilities for TON Prediction Market tests.
 *
 * Provides:
 * - Property-based testing configuration (fast-check profiles)
 * - TON Sandbox helpers
 * - Common test constants
 */

import { configureGlobal } from 'fast-check';

/**
 * fast-check iteration profiles:
 * - CI (default): 100 iterations for quick feedback
 * - Intensive: 10,000 iterations for thorough property validation
 *
 * Set PBT_PROFILE=intensive to use the intensive profile.
 */
const PBT_PROFILE = process.env.PBT_PROFILE ?? 'ci';

const PBT_NUM_RUNS: Record<string, number> = {
  ci: 100,
  intensive: 10_000,
};

const numRuns = PBT_NUM_RUNS[PBT_PROFILE] ?? 100;

configureGlobal({
  numRuns,
  verbose: PBT_PROFILE === 'intensive' ? 1 : 0,
});

/**
 * Returns the configured number of property-based test iterations.
 * Useful when you need to reference the count in test descriptions.
 */
export function getPbtNumRuns(): number {
  return numRuns;
}

/**
 * Common constants used across tests
 */
export const TEST_CONSTANTS = {
  /** Standard gas amount for simple operations */
  DEFAULT_GAS: '0.1',
  /** Higher gas for complex operations (market maker interactions) */
  HIGH_GAS: '0.2',
  /** Fixed-point ONE (2^64) for Q64.64 format */
  FIXED_POINT_ONE: 2n ** 64n,
  /** Fee range constant (10^18) */
  FEE_RANGE: 10n ** 18n,
  /** Maximum outcome slot count */
  MAX_OUTCOMES: 256,
  /** Minimum outcome slot count */
  MIN_OUTCOMES: 2,
} as const;
