# Protocol Overview

> **Contract version:** v0.1.0 | **Acton CLI version:** 1.1.0

## Introduction

The TON Prediction Market is a decentralized prediction market protocol built on The Open Network (TON). It enables users to trade tokenized positions on the outcomes of real-world events using an automated market maker based on the Logarithmic Market Scoring Rule (LMSR).

The protocol implements the **Conditional Tokens Framework** (CTF) — a system for creating, splitting, merging, and redeeming outcome-based positions backed by collateral. An oracle resolves conditions after the event concludes, and position holders redeem their tokens for a proportional share of the collateral pool.

---

## Contract Architecture

The protocol consists of two smart contracts that work together:

### ConditionRegistry

The **ConditionRegistry** is the core bookkeeping contract. It manages:

- **Conditions** — Questions with multiple possible outcomes, registered by an oracle
- **Positions** — Tokenized stakes identified by a `position_id`, tracked in an internal balance ledger
- **Split** — Converting collateral (or a parent position) into outcome-specific positions
- **Merge** — Combining outcome positions back into collateral or a parent position
- **Redeem** — Burning resolved positions and receiving a payout proportional to the oracle's reported result

### LmsrMarketMaker

The **LmsrMarketMaker** provides automated pricing and trade execution. It manages:

- **Market initialization** — Funding the market with collateral and binding it to specific conditions
- **LMSR pricing** — Computing trade costs using the cost function `C(q) = b * ln(Σ exp(q_i / b))`
- **Trade execution** — Processing buy and sell trades, updating internal outcome balances, collecting fees
- **Lifecycle controls** — Pausing, resuming, and closing the market (owner-only operations)
- **Fee collection** — Accumulating trading fees and allowing the owner to withdraw them

### Inter-Contract Relationship

The two contracts communicate via **Jetton `transfer_notification` messaging** (op `0x7362d09c`). When a user sends collateral (Jetton tokens) to either contract's Jetton wallet, the wallet forwards a `transfer_notification` message to the contract. The contract reads the `forward_payload` to determine the intended operation:

- Sending collateral to the **ConditionRegistry's** Jetton wallet with a split payload triggers `SplitPosition`
- Sending collateral to the **LmsrMarketMaker's** Jetton wallet with an init payload triggers `InitMarket`
- Sending collateral to the **LmsrMarketMaker's** Jetton wallet with a trade payload triggers a buy trade

This pattern follows the TON Jetton standard (TEP-74) where token transfers carry a `forward_payload` that the receiving contract interprets.

---

## Message Flows

### Collateral Split (Split Position)

```
User Wallet
  │
  ▼ Jetton transfer (forward_payload: op=0x03, collateralToken, parentCollectionId, conditionId, partition)
Jetton Wallet (of ConditionRegistry)
  │
  ▼ transfer_notification (op=0x7362d09c, amount, sender, forward_payload)
ConditionRegistry
  → Validates partition (disjoint, non-zero, within bounds)
  → Deducts from parent position (or accepts incoming collateral)
  → Mints new positions for each index set in the partition
```

### Merge Positions

```
User Wallet
  │
  ▼ MergePositions (op=0x04, collateralToken, parentCollectionId, conditionId, partition, amount)
ConditionRegistry
  → Validates partition (disjoint, non-zero, within bounds)
  → Burns each partition position (deducts amount from each)
  → Mints parent/union position OR releases collateral (full-set merge with null parent)
```

### Redeem Positions

```
User Wallet
  │
  ▼ RedeemPositions (op=0x05, collateralToken, parentCollectionId, conditionId, indexSets)
ConditionRegistry
  → Verifies condition is resolved (payoutDenominator > 0)
  → For each index set: computes payout_numerator, position_payout = balance * payout_numerator / payout_denominator
  → Zeros out each position balance
  → Credits total payout to parent position (or sends Jetton transfer if parentCollectionId == 0)
```

### Market Initialization

```
User Wallet
  │
  ▼ Jetton transfer (forward_payload: op=0x10, conditionRegistry, conditionCount, conditionIds, outcomeSlotCounts)
Jetton Wallet (of LmsrMarketMaker)
  │
  ▼ transfer_notification (op=0x7362d09c, amount, sender, forward_payload)
LmsrMarketMaker
  → Verifies stage == 255 (uninitialized) and amount > 0
  → Computes atomicOutcomeSlotCount = product of all outcomeSlotCounts
  → Sets stage = Running (0), funding = amount
  → Stores condition configuration
```

### Buy Trade Execution

```
User Wallet
  │
  ▼ Jetton transfer (forward_payload: op=0x11, outcomeTokenAmounts, collateralLimit)
Jetton Wallet (of LmsrMarketMaker)
  │
  ▼ transfer_notification (op=0x7362d09c, amount, sender, forward_payload)
LmsrMarketMaker
  → Verifies market is Running
  → Validates outcomeTokenAmounts length == atomicOutcomeSlotCount
  → Computes netCost = C(q_after) - C(q_before) via LMSR
  → Computes fee = |netCost| * feeRate / 10^18
  → Enforces collateralLimit (if > 0)
  → Verifies transferred amount >= totalCost (netCost + fee)
  → Updates position balances, accumulates fees
```

### Sell Trade Execution

```
User Wallet
  │
  ▼ SellTrade (op=0x12, outcomeTokenAmounts, minCollateralReturn)
LmsrMarketMaker
  → Verifies market is Running
  → Validates outcomeTokenAmounts length == atomicOutcomeSlotCount
  → Computes netCost = C(q_after) - C(q_before) via LMSR (negative for sells)
  → Computes fee = |netCost| * feeRate / 10^18
  → Updates position balances, accumulates fees
```

---

## Market Lifecycle

A prediction market goes through the following phases in order:

### 1. Condition Preparation (`prepareCondition`)

The oracle (or any authorized party) registers a condition on the ConditionRegistry by sending a `PrepareCondition` message (op `0x01`). This specifies:
- The **oracle** address that will later report the outcome
- A **questionId** (256-bit identifier for the question)
- The **outcomeSlotCount** (number of possible outcomes, must be ≥ 2)

The ConditionRegistry computes the `condition_id` and stores the condition data with `payout_denominator = 0` (unresolved).

### 2. Market Initialization (`initMarket` with funding)

A market operator funds the LmsrMarketMaker by sending a Jetton transfer with `forward_payload` containing the `InitMarket` operation (op `0x10`). The transfer amount becomes the LMSR **funding parameter** (`b` value), which determines market liquidity and price sensitivity.

The market transitions from stage `255` (uninitialized) to stage `0` (Running).

### 3. Active Trading (buy/sell via LMSR pricing)

While the market is in the Running state:
- **Buy trades** are executed by sending collateral via Jetton transfer with a trade payload
- **Sell trades** are executed by sending a direct `SellTrade` message

The LMSR cost function prices each trade based on the current outcome balances and the funding parameter.

### 4. Market Pause / Resume / Close (owner lifecycle controls)

The market owner can manage the market state:
- **Pause** (op `0x13`): Running → Paused — halts trading
- **Resume** (op `0x14`): Paused → Running — resumes trading
- **Close** (op `0x15`): Running or Paused → Closed — permanently ends trading

The owner can also adjust fees (`ChangeFee`, op `0x16`), adjust funding while paused (`ChangeFunding`, op `0x17`), and withdraw accumulated fees (`WithdrawFees`, op `0x18`).

### 5. Oracle Resolution (`reportPayouts`)

The oracle sends a `ReportPayouts` message (op `0x02`) to the ConditionRegistry. The message contains payout numerators for each outcome slot. The condition's `payout_denominator` is set to the sum of all payouts, marking the condition as resolved.

Only the oracle address that was specified when the condition was prepared can report payouts (verified by matching the sender address in the condition_id derivation).

### 6. Position Redemption (`redeemPositions`)

After resolution, position holders send a `RedeemPositions` message (op `0x05`) to the ConditionRegistry. For each position:
- The payout numerator is computed by summing the payouts for each outcome bit set in the position's index set
- The position payout is `balance * payout_numerator / payout_denominator` (floor division)
- The position balance is zeroed out
- The total payout is credited to the parent position or sent as a Jetton transfer

---

## Conditional Tokens Framework Concepts

### Condition

A **condition** is a question with a finite number of possible outcomes. It is defined by:
- An **oracle** address (who will resolve it)
- A **questionId** (unique 256-bit identifier for the question)
- An **outcomeSlotCount** (number of atomic outcomes, e.g., 2 for a binary yes/no question)

Once resolved, the condition stores **payout numerators** (one per outcome slot) and a **payout denominator** (the sum of all numerators).

### Position

A **position** is a tokenized stake on a specific combination of outcomes. Each position is uniquely identified by a `position_id` derived from:
- The **collateral token** address
- A **collection_id** that encodes which outcome combination the position represents

Positions are held as balances in the ConditionRegistry's internal ledger (keyed by `hash(positionId, userAddress)`).

### Index Set

An **index set** is a bitmask representing a subset of outcomes within a condition. Each bit corresponds to one atomic outcome slot:
- For a condition with 3 outcomes (A, B, C): `0b001` = A only, `0b010` = B only, `0b100` = C only, `0b011` = A or B, etc.
- The **full index set** is `(1 << outcomeSlotCount) - 1` (all bits set)
- An index set must be non-zero and less than the full index set (i.e., it cannot be the empty set or the full set)

### Collection

A **collection** identifies a specific outcome combination under a specific condition. The `collection_id` is derived from:
- A **parentCollectionId** (0 for top-level positions, non-zero for nested/deep positions)
- The **conditionId** this collection refers to
- The **indexSet** representing which outcomes are included

Collections allow hierarchical nesting — a position can be further split into sub-positions by using its collection_id as the parent for a deeper split.

### Partition

A **partition** is a set of disjoint index sets. When splitting a position, the partition defines how the position is divided:
- Each index set in the partition must be non-zero and within bounds
- Index sets must not overlap (disjoint requirement: `(combined & indexSet) == 0` for each new set)
- A **full-set partition** has a union equal to the full index set (e.g., `{0b01, 0b10}` for a 2-outcome condition)
- A **partial-set partition** has a union that is a proper subset of the full index set

---

## ID Derivation Chain

All identifiers in the system are 256-bit hashes derived by serializing specific fields into a TVM cell and computing the cell's SHA-256 hash.

### Derivation Formulas

```
condition_id  = hash(cell(oracle: address, questionId: uint256, outcomeSlotCount: uint8))
collection_id = hash(cell(parentCollectionId: uint256, conditionId: uint256, indexSet: uint256))
position_id   = hash(cell(collateralToken: address, collectionId: uint256))
```

### Worked Example

Consider a binary prediction market (2 outcomes: Yes/No) with:
- **Oracle address**: `EQDrjaLahLkMB-hMCmkzOyBuHJ186ls...` (267 bits as TON address)
- **Question ID**: `0x0000...0001` (256-bit)
- **Outcome slot count**: `2`
- **Collateral token**: `EQBynBO23ywHy_CgarY9NK9FTz0yDsG...` (267 bits as TON address)

**Step 1 — Compute `condition_id`:**

```
cell_data = storeSlice(oracle) || storeUint(questionId, 256) || storeUint(outcomeSlotCount, 8)
condition_id = SHA256(BoC(cell_data))
```

The resulting `condition_id` is a 256-bit integer uniquely identifying this condition.

**Step 2 — Compute `collection_id` for outcome "Yes" (index set = `0b01 = 1`):**

```
cell_data = storeUint(parentCollectionId=0, 256) || storeUint(condition_id, 256) || storeUint(indexSet=1, 256)
collection_id_yes = SHA256(BoC(cell_data))
```

**Step 3 — Compute `collection_id` for outcome "No" (index set = `0b10 = 2`):**

```
cell_data = storeUint(parentCollectionId=0, 256) || storeUint(condition_id, 256) || storeUint(indexSet=2, 256)
collection_id_no = SHA256(BoC(cell_data))
```

**Step 4 — Compute `position_id` for "Yes" position:**

```
cell_data = storeSlice(collateralToken) || storeUint(collection_id_yes, 256)
position_id_yes = SHA256(BoC(cell_data))
```

**Step 5 — Compute `position_id` for "No" position:**

```
cell_data = storeSlice(collateralToken) || storeUint(collection_id_no, 256)
position_id_no = SHA256(BoC(cell_data))
```

Each user's balance for a position is stored in the ConditionRegistry at the key:
```
balance_key = SHA256(BoC(storeUint(position_id, 256) || storeAddress(userAddress)))
```

---

## Glossary

| Term | Definition |
|------|-----------|
| **condition_id** | A 256-bit hash uniquely identifying a condition, derived from `hash(cell(oracle, questionId, outcomeSlotCount))`. Used as the key in the ConditionRegistry's conditions map. |
| **collection_id** | A 256-bit hash identifying a specific outcome combination under a condition, derived from `hash(cell(parentCollectionId, conditionId, indexSet))`. Encodes which outcomes a position covers and its nesting depth. |
| **position_id** | A 256-bit hash uniquely identifying a position, derived from `hash(cell(collateralToken, collectionId))`. Binds a collection to a specific collateral token. |
| **index set** | A bitmask (stored as uint256) representing a subset of outcomes within a condition. Bit `j` set means outcome slot `j` is included. Must be non-zero and less than the full index set. |
| **partition** | A set of disjoint index sets used when splitting or merging positions. Each index set in the partition must be non-overlapping, and their union defines the scope of the split/merge operation. |
| **payout denominator** | The sum of all payout numerators for a resolved condition. Used as the divisor when computing each position's share of the collateral. A value of 0 indicates an unresolved condition. |
| **payout numerators** | An array of integers (one per outcome slot) reported by the oracle when resolving a condition. Each numerator represents the relative payout weight for that outcome. |
| **atomic outcome slot count** | The total number of distinct outcome combinations across all conditions in a market. Computed as the product of all per-condition outcome slot counts. For a single binary condition: 2. For two binary conditions: 2 × 2 = 4. |
| **funding parameter (LMSR b value)** | The liquidity parameter of the LMSR cost function, set during market initialization. A higher `b` value means tighter spreads and lower price impact per trade. Stored as the `funding` field in MarketStorage. Expressed in raw collateral token units. |
