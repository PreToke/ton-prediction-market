# PreToke — Prediction Market Protocol on TON

PreToke is a decentralized prediction market protocol built on [The Open Network (TON)](https://ton.org). It enables users to trade tokenized positions on the outcomes of real-world events using an automated market maker based on the **Logarithmic Market Scoring Rule (LMSR)**.

The protocol implements the **Conditional Tokens Framework (CTF)** — a system for creating, splitting, merging, and redeeming outcome-based positions backed by collateral. An oracle resolves conditions after an event concludes, and position holders redeem their tokens for a proportional share of the collateral pool.

---

## How It Works

1. **An oracle registers a condition** (a question with multiple possible outcomes) on the ConditionRegistry.
2. **A market operator funds a market** on the LmsrMarketMaker, setting the liquidity depth.
3. **Traders buy and sell outcome positions** priced by the LMSR cost function.
4. **The oracle resolves the condition** by reporting the outcome payouts.
5. **Position holders redeem** their tokens for a proportional share of the collateral.

Collateral flows through TON Jetton transfers (TEP-74), and the contracts communicate via `transfer_notification` messages with structured `forward_payload` data.

---

## Project Structure

```
pretoke-contract/
├── app/                        # React + Vite frontend (dApp)
│   ├── src/
│   │   ├── components/         # UI components (NetworkDropdown, TonDiamond, shadcn)
│   │   ├── lib/                # Utilities (router, TON client, helpers)
│   │   ├── providers/          # React context providers
│   │   ├── App.tsx             # Root application component
│   │   └── main.tsx            # Entry point
│   └── index.html
│
├── contracts/                  # On-chain smart contracts (Tolk)
│   ├── src/
│   │   ├── condition_registry.tolk   # Core bookkeeping: conditions, positions, split/merge/redeem
│   │   ├── lmsr_market_maker.tolk    # Automated market maker with LMSR pricing
│   │   ├── fixed_math.tolk           # Q64.64 fixed-point math library
│   │   ├── types.tolk                # Shared type definitions
│   │   └── jetton/                   # TEP-74 Jetton implementation (test USDT)
│   │       ├── JettonMinter.tolk
│   │       ├── JettonWallet.tolk
│   │       └── ...
│   ├── scripts/                # Deployment & utility scripts (Tolk)
│   │   ├── deploy.tolk               # Main protocol deployment
│   │   └── jetton/                   # Jetton deployment & minting scripts
│   ├── tests/                  # Contract test suite (TypeScript + Vitest)
│   └── wrappers/               # Auto-generated Tolk wrappers for tests/scripts
│
├── docs/                       # Protocol documentation
├── wrappers-ts/                # TypeScript wrappers (generated from contract ABI)
├── Acton.toml                  # Acton project configuration
├── package.json                # npm dependencies and scripts
├── vite.config.ts              # Vite bundler config (frontend)
└── vitest.config.ts            # Test runner config
```

---

## Smart Contracts

| Contract | Source | Purpose |
|----------|--------|---------|
| **ConditionRegistry** | `contracts/src/condition_registry.tolk` | Manages conditions, positions, splitting, merging, and redemption |
| **LmsrMarketMaker** | `contracts/src/lmsr_market_maker.tolk` | Automated pricing via LMSR, trade execution, lifecycle controls, fee management |
| **JettonMinter** | `contracts/src/jetton/JettonMinter.tolk` | Test USDT minter (TEP-74 compliant) for development |
| **JettonWallet** | `contracts/src/jetton/JettonWallet.tolk` | Per-user Jetton wallet for holding collateral |

---

## Getting Started

### Prerequisites

- [Acton CLI](https://ton-blockchain.github.io/acton/) ≥ 1.1.0
- Node.js ≥ 18
- npm

### Install Dependencies

```bash
npm ci
```

### Build Contracts

```bash
acton build
```

### Run Tests

```bash
acton test
```

### Frontend Development

```bash
npm run dev
```

### Type Checking & Formatting

```bash
npm run typecheck
npm run fmt:check
acton fmt --check
```

---

## Deployment

Deploy to testnet using the Acton scripting system:

```bash
# Emulation (local dry-run)
acton script contracts/scripts/deploy.tolk

# Testnet
acton script contracts/scripts/deploy.tolk --net testnet

# Mainnet
acton script contracts/scripts/deploy.tolk --net mainnet
```

See the full [Deployment Guide](docs/deployment-guide.md) for step-by-step instructions, safety checklists, and post-deployment verification.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Protocol Overview](docs/protocol-overview.md) | Architecture, message flows, market lifecycle, and CTF concepts |
| [ConditionRegistry Reference](docs/condition-registry.md) | Storage layout, message handlers, ID derivation, error codes |
| [LmsrMarketMaker Reference](docs/lmsr-market-maker.md) | LMSR cost function, trade execution, lifecycle and admin operations |
| [Fixed-Point Math Library](docs/fixed-point-math.md) | Q64.64 representation, functions, Taylor series, overflow prevention |
| [Deployment Guide](docs/deployment-guide.md) | Prerequisites, environment setup, testnet/mainnet deployment |
| [Test USDT Jetton Guide](docs/test-usdt-jetton.md) | Deploying and minting the test collateral token |

---

## CI Workflows

- **Contracts** (`.github/workflows/contracts.yml`): `acton build` → `acton fmt --check` → `acton check` → `acton test`
- **dApp** (`.github/workflows/dapp.yml`): `npm ci` → `npm run fmt:check` → `npm run typecheck` → `npm run build`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Smart Contracts | [Tolk](https://docs.ton.org/v3/documentation/smart-contracts/tolk/overview) (TON's smart contract language) |
| Build & Test | [Acton CLI](https://ton-blockchain.github.io/acton/) |
| Frontend | React, Vite, TypeScript, Tailwind CSS |
| Token Standard | TEP-74 (Jetton) + TEP-89 (Discoverable Metadata) |
| Math | Q64.64 fixed-point with 9-term Taylor series |

---

## License

[Apache-2.0](LICENSE)
