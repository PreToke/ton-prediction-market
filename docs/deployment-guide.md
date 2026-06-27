# Deployment Guide

> **Contract version:** v0.1.0  
> **Acton CLI version:** 1.1.0  
> **Last updated:** Based on `Acton.toml` package `ton-prediction-market` v0.1.0

This guide covers deploying the TON Prediction Market contracts (ConditionRegistry and LmsrMarketMaker) to testnet and mainnet.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Configuration](#environment-configuration)
3. [Build & Test](#build--test)
4. [Testnet Deployment](#testnet-deployment)
5. [Mainnet Deployment](#mainnet-deployment)
6. [Deployment Sequence](#deployment-sequence)
7. [Post-Deployment Verification](#post-deployment-verification)

---

## Prerequisites

Before deploying, ensure you have the following:

| Requirement | Details |
|-------------|---------|
| **Acton CLI** | Version ≥ 1.1.0. Install or update via the [Acton documentation](https://ton-blockchain.github.io/acton/) |
| **Funded deployer wallet** | Minimum **1 TON** for testnet, minimum **5 TON** for mainnet |
| **Toncenter API keys** | Obtain from [@toncenter](https://t.me/toncenter) Telegram bot |

### Wallet Setup

If you don't have a deployer wallet yet:

```bash
# Create a new wallet
acton wallet new

# List existing wallets
acton wallet list

# Fund on testnet via airdrop
acton wallet airdrop
```

For mainnet, transfer TON to your deployer wallet address from an exchange or another wallet.

---

## Environment Configuration

1. Copy the environment template:

```bash
cp .env.example .env
```

2. Edit `.env` and set your Toncenter API keys:

```dotenv
# For testnet deployment and RPC operations
TONCENTER_TESTNET_API_KEY="your-testnet-key-here"

# For mainnet deployment and RPC operations
TONCENTER_MAINNET_API_KEY="your-mainnet-key-here"
```

> **Note:** Without API keys, Toncenter enforces a 1 RPS rate limit. Keys remove this restriction and speed up deployment transactions. Obtain keys from the [@toncenter](https://t.me/toncenter) Telegram bot.

Acton loads `.env` automatically — no additional configuration is needed.

---

## Build & Test

Always build and test before deploying:

```bash
# Compile both contracts (ConditionRegistry, LmsrMarketMaker)
acton build

# Run the full test suite
acton test
```

Both commands must complete successfully before proceeding to deployment. Fix any compilation errors or test failures before deploying.

---

## Testnet Deployment

Testnet deployment follows a four-step process: build, test, emulate, deploy.

### Step 1: Build contracts

```bash
acton build
```

Confirms that both `ConditionRegistry` and `LmsrMarketMaker` compile without errors.

### Step 2: Run tests

```bash
acton test
```

Verifies all contract logic passes the test suite.

### Step 3: Emulation dry-run

```bash
acton script contracts/scripts/deploy.tolk
```

Runs the deployment script in local emulation mode. This simulates the deployment on a local blockchain without spending any TON. Review the output to confirm:
- Contract addresses are generated
- Deployment transactions succeed in emulation
- Initial state is correct

### Step 4: Live testnet deployment

```bash
acton script contracts/scripts/deploy.tolk --net testnet
```

Deploys contracts to the TON testnet. This spends real testnet TON from your deployer wallet.

After deployment, note the contract addresses printed in the output — you'll need them for initialization and verification.

---

## Mainnet Deployment

Mainnet deployment uses the same commands but with additional safety checkpoints. **Follow each checkpoint carefully.**

### Safety Checklist

Before running the mainnet deployment command, verify each checkpoint:

| # | Checkpoint | How to Verify |
|---|-----------|---------------|
| 1 | All tests pass | Run `acton test` — zero failures |
| 2 | Emulation succeeds | Run `acton script contracts/scripts/deploy.tolk` — no errors |
| 3 | Wallet has sufficient balance | Run `acton wallet list` — confirm ≥ 5 TON |
| 4 | Correct network flag | Double-check you're using `--net mainnet` |
| 5 | Review deployed addresses | After deployment, verify addresses before initialization |

### Step 1: Verify tests pass

```bash
acton test
```

All tests must pass. Do not proceed if any test fails.

### Step 2: Confirm emulation succeeds

```bash
acton script contracts/scripts/deploy.tolk
```

The deployment script must complete without errors in emulation mode.

### Step 3: Verify wallet balance

```bash
acton wallet list
```

Confirm the deployer wallet has at least 5 TON. Deployment of two contracts plus initialization messages requires gas for multiple transactions.

### Step 4: Deploy to mainnet

```bash
acton script contracts/scripts/deploy.tolk --net mainnet
```

> **⚠️ This is irreversible.** Contracts deployed to mainnet cannot be undeployed. Double-check all configuration before executing.

### Step 5: Review deployed addresses

After deployment completes, review the printed contract addresses. Verify them using:

```bash
acton rpc info <deployed-address> --net mainnet
```

Confirm the contract code hash and state match expectations before proceeding to initialization.

---

## Deployment Sequence

The contracts must be deployed and initialized in a specific order due to their interdependencies.

### Order of Operations

```
1. Deploy ConditionRegistry
2. Deploy LmsrMarketMaker
3. Initialize LmsrMarketMaker (via InitMarket Jetton transfer)
```

### Step 1: Deploy ConditionRegistry

Deploy with the following initial storage parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `owner` | `address` | Deployer/admin wallet address |
| `jettonWallet` | `address` | Address of the Jetton wallet that will hold collateral for this contract |

The ConditionRegistry manages conditions and positions. It must be deployed first because the LmsrMarketMaker references it during initialization.

### Step 2: Deploy LmsrMarketMaker

Deploy with the following initial storage parameters:

| Parameter | Type | Description |
|-----------|------|-------------|
| `owner` | `address` | Deployer/admin wallet address |
| `collateralToken` | `address` | Address of the collateral Jetton master contract |
| `jettonWallet` | `address` | Address of the Jetton wallet that will hold collateral for this contract |

The `stage` field is initialized to `255` (Uninitialized) until the InitMarket message is processed.

### Step 3: Initialize LmsrMarketMaker

After both contracts are deployed, initialize the market maker by sending an **InitMarket** message via Jetton transfer (`transfer_notification`):

| Parameter | Type | Description |
|-----------|------|-------------|
| `conditionRegistry` | `address` | Deployed ConditionRegistry address (from Step 1) |
| `conditionIds` | `cell` | Serialized array of `uint256` condition IDs |
| `outcomeSlotCounts` | `cell` | Serialized array of `uint8` values — outcomes per condition |

The Jetton transfer amount becomes the initial **funding** (LMSR `b` parameter). This must be greater than zero.

Upon successful initialization:
- `stage` transitions from `255` (Uninitialized) to `0` (Running)
- `funding` is set to the transferred Jetton amount
- `atomicOutcomeSlotCount` is computed as the product of all per-condition outcome slot counts

> **Important:** Conditions referenced by `conditionIds` should already be prepared on the ConditionRegistry (via `PrepareCondition`) before initializing the market.

---

## Post-Deployment Verification

After deploying and initializing, verify the contracts are correctly configured.

### 1. Verify contract ownership

Call the `owner()` get-method on both contracts to confirm the owner address:

```bash
# Check ConditionRegistry owner
acton rpc info <condition-registry-address>

# Check LmsrMarketMaker owner
acton rpc info <lmsr-market-maker-address>
```

The returned owner address should match your deployer wallet.

### 2. Verify LmsrMarketMaker stage

Call the `stage()` get-method on LmsrMarketMaker:

- **Before initialization:** `stage = 255` (Uninitialized)
- **After initialization:** `stage = 0` (Running)

If stage is still 255 after sending the InitMarket transfer, the initialization transaction may have failed. Check transaction history.

### 3. Verify ConditionRegistry conditions

Call `get_condition(conditionId)` on ConditionRegistry to verify conditions are prepared:

The method returns a tuple of `(oracle, questionId, outcomeSlotCount, payoutDenominator)`:
- `payoutDenominator = 0` means the condition is unresolved (expected for active markets)
- `payoutDenominator > 0` means the condition has been resolved

### 4. Inspect on-chain contract state

Use the Acton RPC tool to inspect full contract state:

```bash
# General contract info (balance, state, code hash)
acton rpc info <address>

# With network flag for mainnet
acton rpc info <address> --net mainnet
```

This shows:
- Contract balance (ensure sufficient for gas reserves)
- Contract state (should be "active")
- Code hash (can be compared against the compiled output)

### 5. Source verification (optional)

For transparency, verify that the on-chain code matches your local source:

```bash
acton verify <address> --net mainnet
```

---

## Troubleshooting

### Deployment transaction fails with insufficient gas

**Symptom:** Deployment script errors with a gas-related failure.  
**Cause:** Deployer wallet has insufficient TON balance.  
**Resolution:** Top up the deployer wallet and retry:

```bash
# Testnet: use airdrop
acton wallet airdrop

# Mainnet: transfer more TON to the deployer address
```

### Wrong network deployment

**Symptom:** Contract deployed to testnet instead of mainnet (or vice versa).  
**Cause:** Incorrect `--net` flag or missing flag (defaults to emulation).  
**Resolution:** Always explicitly specify the network flag. Contracts cannot be "moved" between networks — you must redeploy to the correct network.

### InitMarket transaction not processed

**Symptom:** `stage()` returns 255 after sending the initialization Jetton transfer.  
**Cause:** The Jetton transfer was sent to the wrong address, or the `transfer_notification` was not forwarded correctly.  
**Resolution:**
1. Verify you're sending the Jetton transfer to the LmsrMarketMaker's Jetton wallet (not the contract address directly)
2. Confirm the forward payload contains the correct `OP_INIT_MARKET` (0x10) op-code
3. Ensure the transfer amount is greater than zero

### API key rate limiting

**Symptom:** Deployment hangs or times out during network operations.  
**Cause:** Missing or invalid Toncenter API key, causing 1 RPS rate limiting.  
**Resolution:** Set a valid API key in `.env`:

```bash
TONCENTER_TESTNET_API_KEY="your-key"
TONCENTER_MAINNET_API_KEY="your-key"
```

Obtain keys from the [@toncenter](https://t.me/toncenter) Telegram bot.
