# Test USDT Jetton (tUSDT) — Deployment & Minting Guide

> **Contract version:** v1.0.0  
> **Acton CLI version:** 1.1.0  
> **Source:** `contracts/src/jetton/`  
> **Standard:** TEP-74 (Jetton Standard) + TEP-89 (Discoverable Metadata)

## Overview

This is a mintable test Jetton that mimics USDT for development and testing of the TON Prediction Market contracts. It uses 6 decimals (same as real USDT on TON) and gives the deployer full admin control to mint tokens freely.

| Property | Value |
|----------|-------|
| Name | Test USDT |
| Symbol | tUSDT |
| Decimals | 6 |
| Admin | Deployer wallet |
| Mintable | Yes (admin-only) |
| Standard | TEP-74 + TEP-89 |

## Architecture

The Jetton follows the standard TON two-contract model:

```
┌─────────────────┐          ┌─────────────────┐
│  JettonMinter   │          │  JettonWallet    │
│  (master)       │  deploys │  (per-user)      │
│                 │ ───────► │                   │
│ • mint()        │          │ • transfer()     │
│ • burn_notif()  │          │ • burn()         │
│ • get_wallet()  │          │ • get_balance()  │
└─────────────────┘          └─────────────────┘
        │                           │
        │  One minter               │  One wallet per owner
        │  controls supply          │  holds balance
```

- **JettonMinter** — Single master contract that tracks total supply, stores metadata, and creates new wallets on mint.
- **JettonWallet** — Deployed automatically for each unique owner. Holds that owner's balance and handles transfers.

## Prerequisites

### 1. Acton CLI installed

```bash
acton --version
# Should show 1.1.0 or later
```

If not installed:
```bash
curl -LsSf https://github.com/ton-blockchain/acton/releases/latest/download/acton-installer.sh | sh
```

### 2. Deployer wallet with testnet TON

Your deployer wallet is defined in `wallets.toml`:

```toml
[wallets.deployer]
kind = "v5r1"
workchain = 0
keys = { mnemonic = "..." }

[wallets.deployer.expected]
address-testnet = "kQBa4312nAIbWDjdAAybrGxE4K6eo9XiFtjf7ZXciV1rEVCn"
```

Fund it with testnet TON if needed:
```bash
acton wallet airdrop --net testnet
```

### 3. TonCenter API key (optional but recommended)

Create a `.env` file in the project root:
```bash
cp .env.example .env
```

Add your TonCenter testnet API key:
```
TONCENTER_TESTNET_API_KEY=your_key_here
```

Get a free key from [@tonapibot](https://t.me/tonapibot) on Telegram.

## Step-by-Step Deployment

### Option A: Quick Setup (Deploy + Mint in One Command)

This deploys the minter and immediately mints 1,000,000 tUSDT to your deployer wallet:

```bash
# Test locally first (emulation)
acton run jetton-setup

# Deploy to testnet
acton run jetton-setup-testnet
```

Expected output:
```
Deployer/Admin: kQBa4312nAIbWDjdAAybrGxE4K6eo9XiFtjf7ZXciV1rEVCn

✓ Test USDT Minter deployed: kQA_pHK8xuifh6EFVQ1MWyT5vzEMyHFh4bJeJBHOh605OfTC

Minting 1000000 tUSDT to kQBa4312nAIbWDjdAAybrGxE4K6eo9XiFtjf7ZXciV1rEVCn
...

═══════════════════════════════════════════════════
  Test USDT Setup Complete
═══════════════════════════════════════════════════
  Minter address:   kQA_pHK8...
  Admin:            kQBa4312...
  Total supply:     1000000 tUSDT
  Mintable:         true

  Recipient:        kQBa4312...
  Recipient wallet: kQBvezuX...
  Balance:          1000000 tUSDT
```

**Save the minter address** — you'll need it for all subsequent minting operations.

### Option B: Step-by-Step (Separate Deploy and Mint)

#### Step 1: Deploy the Minter

```bash
# Emulation first
acton run jetton-deploy

# Then testnet
acton run jetton-deploy-testnet
```

Note the minter address from the output.

#### Step 2: Mint Tokens

```bash
# Set the minter address from step 1
export JETTON_MINTER_ADDRESS=kQA_pHK8xuifh6EFVQ1MWyT5vzEMyHFh4bJeJBHOh605OfTC

# Mint to deployer (default 1M tUSDT)
acton run jetton-mint-testnet

# Or mint to a specific address
MINT_RECIPIENT=EQxxx... acton run jetton-mint-testnet
```

## Minting to Team Wallets

Once the minter is deployed, you can mint to any address. Run the mint script multiple times with different recipients.

### Mint to multiple team wallets

```bash
export JETTON_MINTER_ADDRESS=<your_minter_address>

# Mint 1M tUSDT to team member 1
MINT_RECIPIENT=EQTeamMember1Address... acton run jetton-mint-testnet

# Mint 500k tUSDT to team member 2
MINT_RECIPIENT=EQTeamMember2Address... MINT_AMOUNT=500000000000 acton run jetton-mint-testnet

# Mint 2M tUSDT to team member 3
MINT_RECIPIENT=EQTeamMember3Address... MINT_AMOUNT=2000000000000 acton run jetton-mint-testnet
```

### Amount reference (6 decimals)

| Human-readable | Raw value (MINT_AMOUNT) |
|----------------|-------------------------|
| 1 tUSDT | 1000000 |
| 100 tUSDT | 100000000 |
| 1,000 tUSDT | 1000000000 |
| 10,000 tUSDT | 10000000000 |
| 100,000 tUSDT | 100000000000 |
| 1,000,000 tUSDT | 1000000000000 |

### Batch minting script (shell)

For convenience, create a shell script to mint to all team wallets at once:

```bash
#!/bin/bash
# scripts/mint-team.sh

export JETTON_MINTER_ADDRESS="kQA_pHK8xuifh6EFVQ1MWyT5vzEMyHFh4bJeJBHOh605OfTC"
AMOUNT=1000000000000  # 1M tUSDT each

WALLETS=(
  "EQTeamMember1..."
  "EQTeamMember2..."
  "EQTeamMember3..."
)

for wallet in "${WALLETS[@]}"; do
  echo "Minting to $wallet..."
  MINT_RECIPIENT="$wallet" MINT_AMOUNT="$AMOUNT" acton run jetton-mint-testnet
  echo ""
done
```

## Verifying Deployment

### Check minter info on-chain

After deployment you can inspect the minter state:

```bash
acton rpc info <minter_address> --net testnet
```

### Check via TON explorers

- **Tonviewer**: `https://testnet.tonviewer.com/<minter_address>`
- **Tonscan**: `https://testnet.tonscan.org/address/<minter_address>`

The jetton metadata (name, symbol, decimals, image) will be visible on explorers.

### Check a wallet balance

Look up any wallet's jetton balance on the explorer by navigating to the owner address and checking the "Jettons" tab.

## Integration with Prediction Market Contracts

After deploying tUSDT, use the minter address as the **collateral token** when initializing the prediction market:

1. **Condition Registry** — Set the `jettonWallet` field to the Jetton Wallet address of the registry contract.  
2. **LMSR Market Maker** — The market maker's `collateralToken` in the config should point to the minter address. Its `jettonWallet` is computed from the minter.

To compute the Jetton Wallet address for any contract:
```
Jetton Wallet address = JettonMinter.get_wallet_address(contract_address)
```

This is handled automatically by the minter contract's getter.

## Available Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| Deploy (emulation) | `acton run jetton-deploy` | Deploy minter locally |
| Deploy (testnet) | `acton run jetton-deploy-testnet` | Deploy minter to testnet |
| Mint (emulation) | `acton run jetton-mint` | Mint tokens locally |
| Mint (testnet) | `acton run jetton-mint-testnet` | Mint tokens on testnet |
| Setup (emulation) | `acton run jetton-setup` | Deploy + mint locally |
| Setup (testnet) | `acton run jetton-setup-testnet` | Deploy + mint on testnet |

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `JETTON_MINTER_ADDRESS` | mint | Address of deployed minter |
| `MINT_RECIPIENT` | mint, setup | Recipient address (defaults to deployer) |
| `MINT_AMOUNT` | mint, setup | Amount in raw units (defaults to 1,000,000,000,000 = 1M tUSDT) |
| `TONCENTER_TESTNET_API_KEY` | all --net testnet | TonCenter API key for RPC access |

## File Structure

```
contracts/
├── src/
│   └── jetton/
│       ├── JettonMinter.tolk       # Master contract (admin, mint, metadata)
│       ├── JettonWallet.tolk       # Wallet contract (balance, transfer, burn)
│       ├── messages.tolk           # Message structs & opcodes (TEP-74)
│       ├── storage.tolk            # Storage structs & helpers
│       ├── errors.tolk             # Error codes
│       ├── fees-management.tolk    # Gas & fee calculations
│       ├── jetton-utils.tolk       # Wallet address computation
│       └── sharding.tolk           # Workchain & shard constants
├── scripts/
│   └── jetton/
│       ├── deploy-test-usdt.tolk   # Deploy minter only
│       ├── mint.tolk               # Mint to a recipient
│       └── deploy-and-mint.tolk    # Combined deploy + mint
└── wrappers/
    ├── JettonMinter.gen.tolk       # Auto-generated minter wrapper
    └── JettonWallet.gen.tolk       # Auto-generated wallet wrapper
```

## Troubleshooting

### "Cannot run method of not deployed contract"

This happens when running the mint script in emulation without deploying first. In emulation, use the combined script:
```bash
acton run jetton-setup
```

For testnet, make sure you deployed first with `acton run jetton-deploy-testnet`.

### "Not enough gas" or transaction fails

Ensure your deployer has enough testnet TON. Each mint costs ~0.1 TON in gas:
```bash
acton wallet airdrop --net testnet
```

### "NotOwner" error on mint

Only the admin (deployer) can mint. Make sure the wallet sending the mint transaction is the same one that deployed the minter.

### Wallet not showing balance on explorer

Jetton wallets are deployed lazily — they're created on first mint/transfer to that address. If you just deployed the minter, no wallets exist yet until you mint.

## Security Notes

- This is a **test token only**. The admin has unrestricted minting power.
- Never use this on mainnet for real value. For production, drop the admin after initial distribution using the `DropMinterAdmin` message.
- The mnemonic in `wallets.toml` is a development key. Do not use it for mainnet deployments.
