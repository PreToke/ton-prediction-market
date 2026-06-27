# ConditionRegistry Contract Reference

> **Contract version:** v0.1.0  
> **Acton CLI version:** 1.1.0  
> **Source:** `contracts/src/condition_registry.tolk`

---

## Overview

The **ConditionRegistry** is the core contract of the TON Prediction Market protocol responsible for managing prediction market conditions and positions. It handles:

- **Condition preparation** — Registering new questions (conditions) with multiple possible outcomes
- **Oracle resolution** — Accepting payout reports from designated oracles to resolve conditions
- **Position splitting** — Converting collateral or parent positions into child outcome positions
- **Position merging** — Combining child outcome positions back into collateral or parent positions
- **Position redemption** — Allowing holders to claim payouts from resolved conditions

The contract interacts with Jetton wallets via `transfer_notification` messages to receive collateral for split operations, and sends Jetton transfer messages to refund collateral during merges and redemptions.

---

## Storage Layout

The contract uses a single top-level struct persisted in contract data:

### RegistryStorage

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `owner` | `address` | 267 bits (std) | Contract owner address; used for admin operations |
| `jettonWallet` | `address` | 267 bits (std) | Address of the contract's Jetton wallet; validates `transfer_notification` senders |
| `conditions` | `map<uint256, cell>` | dict (256-bit keys) | Maps `condition_id` → condition data cell containing oracle, questionId, outcomeSlotCount, payoutDenominator, and payout numerators |
| `balances` | `map<uint256, coins>` | dict (256-bit keys) | Maps balance key (hash of positionId + userAddress) → token amount held by that user for that position |

**Condition data cell layout** (stored as values in the `conditions` map):

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `oracle` | `address` | 267 bits | The oracle address authorized to resolve this condition |
| `questionId` | `uint256` | 256 bits | Unique identifier for the question |
| `outcomeSlotCount` | `uint8` | 8 bits | Number of possible outcomes (≥ 2) |
| `payoutDenominator` | `uint256` | 256 bits | Sum of all payout numerators; 0 when unresolved |
| `payoutNumerators` | `cell` (ref) | reference | Dictionary or flat cell containing payout values per outcome slot |

**Balance key derivation:**

The balance map key is computed as the cell hash of `(positionId: uint256, userAddress: address)`, ensuring each user-position pair has a unique 256-bit key.

---

## Message Handlers

### PrepareCondition (op = 0x01)

Registers a new condition (question) with the specified oracle and outcome count.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier for response correlation |
| `oracle` | `address` | 267 bits | Address authorized to report payouts for this condition |
| `questionId` | `uint256` | 256 bits | Unique question identifier |
| `outcomeSlotCount` | `uint8` | 8 bits | Number of possible outcomes |

**Step-by-step behavior:**

1. Validate `outcomeSlotCount >= 2`; throw `InvalidOutcomeCount` (200) if not
2. Load `RegistryStorage` from contract data
3. Serialize the oracle address into a slice, then compute `condition_id = get_condition_id(oracle, questionId, outcomeSlotCount)`
4. Assert the condition does not already exist in the `conditions` map; throw `ConditionAlreadyExists` (201) if it does
5. Build a condition data cell containing: oracle, questionId, outcomeSlotCount, payoutDenominator = 0 (unresolved), empty payout numerators dict
6. Store the condition data cell in `conditions[condition_id]`
7. Save updated storage

---

### ReportPayouts (op = 0x02)

Resolves a condition by accepting payout numerators from the oracle.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier for response correlation |
| `questionId` | `uint256` | 256 bits | The question being resolved |
| `payoutCount` | `uint8` | 8 bits | Number of payout values (must equal outcomeSlotCount) |
| `payouts` | `cell` (ref) | reference | Cell containing `payoutCount` consecutive uint256 payout numerator values |

**Step-by-step behavior:**

1. Load `RegistryStorage`
2. Compute `condition_id = get_condition_id(sender_address, questionId, payoutCount)` — the message sender IS the oracle
3. Look up the condition in `conditions[condition_id]`; throw `ConditionNotFound` (202) if absent
4. Parse the existing condition data and check `payoutDenominator == 0`; throw `ConditionAlreadyResolved` (203) if non-zero
5. Parse the `payouts` cell: read `payoutCount` uint256 values, summing them into `denominator`
6. Assert `denominator != 0`; throw `AllZeroPayouts` (205) if all payouts are zero
7. Rebuild the condition data cell with the computed `denominator` as `payoutDenominator` and the `payouts` cell as the payout numerators reference
8. Update `conditions[condition_id]` with the new data cell
9. Save updated storage

---

### SplitPosition via transfer_notification (op = 0x7362d09c)

Splits collateral or a parent position into child outcome positions. This message arrives as a Jetton `transfer_notification` with a `forward_payload` containing split parameters.

**Outer transfer_notification fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `op` | `uint32` | 32 bits | Fixed: `0x7362d09c` (transfer_notification) |
| `queryId` | `uint64` | 64 bits | Query identifier |
| `amount` | `coins` | variable (4-bit length prefix + value) | Amount of Jettons transferred (collateral to split) |
| `sender` | `address` | 267 bits | Original sender (the user initiating the split) |
| `forward_payload` | `cell` (ref) | reference | Contains split parameters |

**Forward payload (OP_SPLIT_POSITION = 0x03) fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `op` | `uint32` | 32 bits | Fixed: `0x03` |
| `collateralToken` | `address` | 267 bits | Collateral token address |
| `parentCollectionId` | `uint256` | 256 bits | Parent collection ID (0 for root split) |
| `conditionId` | `uint256` | 256 bits | Target condition ID |
| `partitionCount` | `uint8` | 8 bits | Number of index sets in partition |
| `partition` | `cell` (ref) | reference | Cell containing `partitionCount` consecutive uint256 index set values |

**Step-by-step behavior:**

1. Parse the outer `transfer_notification`: extract `amount`, `sender`, and `forward_payload`
2. Load `RegistryStorage` and verify `in.senderAddress == storage.jettonWallet`; throw `InvalidMessage` (0xFFFF) if not
3. Parse `forward_payload`: read op (must be 0x03; throw `InvalidMessage` if not), then `collateralToken`, `parentCollectionId`, `conditionId`, `partitionCount`, and `partition` cell
4. Look up the condition; throw `ConditionNotFound` (202) if absent
5. Extract `outcomeSlotCount` from condition data
6. Delegate to `handleSplit` (see [Split Position Logic](#split-position-logic))

---

### MergePositions (op = 0x04)

Merges child positions back into a parent position or collateral.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier |
| `collateralToken` | `address` | 267 bits | Collateral token address |
| `parentCollectionId` | `uint256` | 256 bits | Parent collection ID (0 for root merge → collateral refund) |
| `conditionId` | `uint256` | 256 bits | Target condition ID |
| `partitionCount` | `uint8` | 8 bits | Number of index sets in partition |
| `partition` | `cell` (ref) | reference | Cell containing `partitionCount` consecutive uint256 index set values |
| `amount` | `coins` | variable | Amount to merge from each partition position |

**Step-by-step behavior:**

1. Load `RegistryStorage`
2. Look up the condition in `conditions[conditionId]`; throw `ConditionNotFound` (202) if absent
3. Parse condition data to extract `outcomeSlotCount`
4. Delegate to `handleMerge` (see [Merge Position Logic](#merge-position-logic))

---

### RedeemPositions (op = 0x05)

Redeems positions from a resolved condition, receiving proportional payouts.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier |
| `collateralToken` | `address` | 267 bits | Collateral token address |
| `parentCollectionId` | `uint256` | 256 bits | Parent collection ID (0 for root redeem → Jetton transfer) |
| `conditionId` | `uint256` | 256 bits | Target condition ID |
| `indexSetCount` | `uint8` | 8 bits | Number of index sets to redeem |
| `indexSets` | `cell` (ref) | reference | Cell containing `indexSetCount` consecutive uint256 index set values |

**Step-by-step behavior:**

1. Load `RegistryStorage`
2. Look up the condition; throw `ConditionNotFound` (202) if absent
3. Parse condition data: extract `outcomeSlotCount`, `payoutDenominator`, and `payoutsRef` cell
4. Assert `payoutDenominator > 0`; throw `ConditionNotResolved` (208) if condition is unresolved
5. Compute `fullIndexSet = (1 << outcomeSlotCount) - 1`
6. For each index set in `indexSets`:
   - Validate `indexSet > 0` and `indexSet < fullIndexSet`; throw `InvalidIndexSet` (209) if not
   - Compute `payoutNumerator` (see [Redeem Logic](#redeem-logic))
   - Compute `collectionId` and `positionId` for this index set
   - Read the user's balance for the position
   - Compute `positionPayout = balance * payoutNumerator / payoutDenominator` (floor division)
   - Add `positionPayout` to `totalPayout`
   - Zero out the user's balance for this position
7. If `totalPayout > 0` and `parentCollectionId != 0`: credit `totalPayout` to the parent position balance
8. If `totalPayout > 0` and `parentCollectionId == 0`: send a Jetton transfer to return collateral
9. Save updated storage

---

## ID Derivation Functions

All ID derivation functions serialize their inputs into a cell and return the SHA-256 hash of the cell's BoC representation.

### get_condition_id

Computes a unique identifier for a condition.

**Inputs:**

| Parameter | Type | Bit-width |
|-----------|------|-----------|
| `oracle` | `slice` (address) | 267 bits |
| `questionId` | `int` (uint256) | 256 bits |
| `outcomeSlotCount` | `int` (uint8) | 8 bits |

**Cell layout:** `[oracle: slice][questionId: uint256][outcomeSlotCount: uint8]`

**Returns:** `int` — 256-bit cell hash

---

### get_collection_id

Computes a unique identifier for a collection (position group under a condition + index set).

**Inputs:**

| Parameter | Type | Bit-width |
|-----------|------|-----------|
| `parentCollectionId` | `int` (uint256) | 256 bits |
| `conditionId` | `int` (uint256) | 256 bits |
| `indexSet` | `int` (uint256) | 256 bits |

**Cell layout:** `[parentCollectionId: uint256][conditionId: uint256][indexSet: uint256]`

**Returns:** `int` — 256-bit cell hash

---

### get_position_id

Computes a unique identifier for a specific position.

**Inputs:**

| Parameter | Type | Bit-width |
|-----------|------|-----------|
| `collateralToken` | `slice` (address) | 267 bits |
| `collectionId` | `int` (uint256) | 256 bits |

**Cell layout:** `[collateralToken: slice][collectionId: uint256]`

**Returns:** `int` — 256-bit cell hash

---

## Split Position Logic

The `handleSplit` function processes position splitting with three distinct scenarios based on the partition and parent context.

### Validation

1. `partitionCount >= 2`; throw `InvalidPartition` (206) if not
2. Compute `fullIndexSet = (1 << outcomeSlotCount) - 1`
3. For each index set in the partition:
   - Must be `> 0`; throw `InvalidPartition` (206) otherwise
   - Must be `< fullIndexSet`; throw `InvalidPartition` (206) otherwise
   - Must not overlap with any previously seen index set (disjoint requirement); throw `InvalidPartition` (206) if overlap detected
4. Compute `combinedIndexSet` as the bitwise OR of all index sets

### Full-Set Split

**Condition:** `combinedIndexSet == fullIndexSet` (partition covers all outcomes)

**With `parentCollectionId == 0` (collateral split):**
- The incoming Jetton `amount` serves as the collateral being split
- No existing position is burned — the transferred Jettons are the source
- For each index set in the partition: mint `amount` tokens in the corresponding child position

**With `parentCollectionId != 0` (deep split):**
- Compute the parent position ID from `(collateralToken, parentCollectionId)`
- Assert user's parent position balance >= `amount`; throw `InsufficientBalance` (207) if not
- Deduct `amount` from the parent position balance
- For each index set in the partition: mint `amount` tokens in the corresponding child position

### Partial-Set Split

**Condition:** `combinedIndexSet != fullIndexSet` (partition covers a proper subset of outcomes)

- Compute the union position: `get_collection_id(parentCollectionId, conditionId, combinedIndexSet)`
- Assert user's union position balance >= `amount`; throw `InsufficientBalance` (207) if not
- Burn `amount` from the union position
- For each index set in the partition: mint `amount` tokens in the corresponding child position

---

## Merge Position Logic

The `handleMerge` function processes position merging — the inverse of splitting.

### Validation

Same as split validation:
1. `partitionCount >= 2`
2. Each index set: `> 0`, `< fullIndexSet`, no overlaps
3. Compute `combinedIndexSet`

### Burning Phase (common to all merge types)

For each index set in the partition:
- Compute the position ID via `get_collection_id(parentCollectionId, conditionId, indexSet)` → `get_position_id(collateralToken, collectionId)`
- Assert user's balance >= `amount`; throw `InsufficientBalance` (207) if not
- Deduct `amount` from each position's balance

### Full-Set Merge with Null Parent

**Condition:** `combinedIndexSet == fullIndexSet` AND `parentCollectionId == 0`

- This is a **collateral refund**: all outcome positions are merged back into raw collateral
- Sends a Jetton transfer of `amount` back to the user
- No position is minted

### Full-Set Merge with Non-Null Parent

**Condition:** `combinedIndexSet == fullIndexSet` AND `parentCollectionId != 0`

- This is a **deep merge**: outcome positions merge back into their parent position
- Mints `amount` tokens in the parent position: `get_position_id(collateralToken, parentCollectionId)`

### Partial-Set Merge

**Condition:** `combinedIndexSet != fullIndexSet`

- Computes the union collection: `get_collection_id(parentCollectionId, conditionId, combinedIndexSet)`
- Mints `amount` tokens in the union position

---

## Redeem Logic

Redemption allows position holders to claim payouts from resolved conditions.

### Payout Numerator Computation

For a given `indexSet`, the `payoutNumerator` is computed by summing the payout values for each outcome slot bit that is set:

```
payoutNumerator = Σ payouts[j]  for each j where bit j of indexSet is 1
```

The payouts array is read sequentially from the condition's `payoutsRef` cell (each value is uint256).

### Position Payout Formula

```
positionPayout = balance * payoutNumerator / payoutDenominator
```

This uses **floor division** (integer division truncating toward zero). The `payoutDenominator` is the sum of all payout numerators stored when the oracle resolved the condition.

### Balance Zeroing

After computing the payout for a position, the user's entire balance for that position is set to zero — regardless of the computed payout amount. This ensures positions cannot be redeemed twice.

### Total Payout Crediting

The `totalPayout` accumulates all `positionPayout` values across the redeemed index sets. After processing all index sets:

- **If `parentCollectionId != 0`:** The `totalPayout` is credited (minted) to the user's parent position balance
- **If `parentCollectionId == 0`:** The `totalPayout` is sent to the user as a Jetton transfer (collateral returned)

---

## Error Codes

All errors are defined in the `RegistryErrors` enum:

| Code | Name | Trigger Condition |
|------|------|-------------------|
| 100 | `NotOwner` | Sender is not the contract owner (reserved for admin operations) |
| 0xFFFF | `InvalidMessage` | Unrecognized op-code; `transfer_notification` sender is not the registered Jetton wallet; forward_payload op is not `OP_SPLIT_POSITION` |
| 200 | `InvalidOutcomeCount` | `outcomeSlotCount < 2` in PrepareCondition |
| 201 | `ConditionAlreadyExists` | Attempting to prepare a condition with a `condition_id` that already exists in storage |
| 202 | `ConditionNotFound` | Referenced `conditionId` does not exist in the `conditions` map (applies to ReportPayouts, SplitPosition, MergePositions, RedeemPositions) |
| 203 | `ConditionAlreadyResolved` | Attempting to report payouts for a condition whose `payoutDenominator` is already non-zero |
| 204 | `InvalidOracle` | Reserved — the oracle identity is validated implicitly via `condition_id` derivation from sender address |
| 205 | `AllZeroPayouts` | All payout numerator values sum to zero in ReportPayouts |
| 206 | `InvalidPartition` | Partition validation fails: `partitionCount < 2`, any index set is 0, any index set >= `fullIndexSet`, or index sets overlap (not disjoint) |
| 207 | `InsufficientBalance` | User's position balance is less than the requested split/merge amount |
| 208 | `ConditionNotResolved` | Attempting to redeem positions from a condition with `payoutDenominator == 0` (not yet resolved) |
| 209 | `InvalidIndexSet` | In RedeemPositions: an index set is 0 or >= `fullIndexSet` |
| 210 | `InsufficientGas` | Message value is less than 0.1 TON (100,000,000 nanotons) |

---

## Gas Requirements

The contract enforces a minimum gas requirement at the entry point of `onInternalMessage`:

```
assert(in.valueCoins >= 100000000) throw RegistryErrors.InsufficientGas
```

- **Minimum:** 0.1 TON (100,000,000 nanotons)
- **Purpose:** Ensures sufficient gas for storage operations (dictionary updates) and any outbound messages
- **Scope:** Applies to ALL incoming internal messages regardless of operation type

---

## Get-Methods

### owner()

Returns the contract owner address.

```
get fun owner(): address
```

**Returns:** The `owner` field from `RegistryStorage`.

---

### get_condition(conditionId: int)

Returns the parsed data for a specific condition.

```
get fun get_condition(conditionId: int): (address, int, int, int)
```

**Parameters:**
- `conditionId` — 256-bit condition identifier

**Returns tuple:**
1. `oracle` (address) — The oracle authorized to resolve this condition
2. `questionId` (int/uint256) — The question identifier
3. `outcomeSlotCount` (int/uint8) — Number of possible outcomes
4. `payoutDenominator` (int/uint256) — Sum of payout numerators (0 if unresolved)

**Errors:** Throws `ConditionNotFound` (202) if the condition does not exist.

---

### compute_condition_id(oracle: slice, questionId: int, outcomeSlotCount: int)

Computes the condition ID for given parameters without modifying state.

```
get fun compute_condition_id(oracle: slice, questionId: int, outcomeSlotCount: int): int
```

**Returns:** 256-bit hash (same as `get_condition_id` internal function).

---

### compute_collection_id(parentCollectionId: int, conditionId: int, indexSet: int)

Computes the collection ID for given parameters without modifying state.

```
get fun compute_collection_id(parentCollectionId: int, conditionId: int, indexSet: int): int
```

**Returns:** 256-bit hash (same as `get_collection_id` internal function).

---

### compute_position_id(collateralToken: slice, collectionId: int)

Computes the position ID for given parameters without modifying state.

```
get fun compute_position_id(collateralToken: slice, collectionId: int): int
```

**Returns:** 256-bit hash (same as `get_position_id` internal function).
