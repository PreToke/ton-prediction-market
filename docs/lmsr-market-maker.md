# LmsrMarketMaker Contract Reference

> **Contract version:** v0.1.0  
> **Acton CLI version:** 1.1.0  
> **Source:** `contracts/src/lmsr_market_maker.tolk`

---

## Overview

The **LmsrMarketMaker** is the automated market maker (AMM) contract of the TON Prediction Market protocol, implementing the Logarithmic Market Scoring Rule (LMSR) for pricing outcome tokens. It handles:

- **Market initialization** — Receiving initial funding via Jetton transfer to bootstrap the market
- **LMSR pricing** — Computing trade costs using the cost function C(q) = b × ln(Σ exp(qᵢ / b))
- **Trade execution** — Processing buy trades (via Jetton transfer) and sell trades (via direct message)
- **Lifecycle controls** — Pause, resume, and close operations for market management
- **Fee collection** — Accumulating trading fees and allowing owner withdrawal
- **Admin operations** — Adjusting fee rate, modifying funding parameter, withdrawing fees

The contract receives buy trade collateral and market initialization funding via Jetton `transfer_notification` messages from its configured Jetton wallet. Sell trades are sent directly to the contract.

---

## Storage Layout

The contract uses a nested storage structure with cell references for configuration and state data.

### MarketStorage (top-level)

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `owner` | `address` | 267 bits (std) | Contract owner; authorized for admin and lifecycle operations |
| `atomicOutcomeSlotCount` | `uint32` | 32 bits | Total number of atomic outcomes (product of per-condition slot counts) |
| `funding` | `uint128` | 128 bits | LMSR liquidity parameter (b value); determines price sensitivity |
| `fee` | `uint64` | 64 bits | Fee rate applied to trades (0 to 10^18, denominator = FEE_RANGE) |
| `stage` | `uint8` | 8 bits | Market lifecycle stage: 0=Running, 1=Paused, 2=Closed, 255=Uninitialized |
| `config` | `Cell<MarketConfig>` | reference | Cell reference to market configuration data |
| `state` | `Cell<MarketState>` | reference | Cell reference to mutable market state data |

### MarketConfig (cell reference from MarketStorage)

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `conditionRegistry` | `address` | 267 bits | Address of the ConditionRegistry contract |
| `collateralToken` | `address` | 267 bits | Address of the collateral token (Jetton master) |
| `jettonWallet` | `address` | 267 bits | Address of this contract's Jetton wallet; validates transfer_notification senders |
| `conditionIds` | `cell` | reference | Serialized array of condition_id values (uint256 each) |
| `outcomeSlotCounts` | `cell` | reference | Serialized array of outcome slot counts (uint8 per condition) |

### MarketState (cell reference from MarketStorage)

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `positionBalances` | `map<uint32, int128>` | dict (32-bit keys) | Maps atomic outcome index → current position balance (can be negative for sells) |
| `positionIds` | `map<uint32, uint256>` | dict (32-bit keys) | Maps atomic outcome index → cached position_id |
| `accumulatedFees` | `uint128` | 128 bits | Total accumulated trading fees available for withdrawal |

**Nesting relationship:**

```
MarketStorage
├── owner, atomicOutcomeSlotCount, funding, fee, stage (inline)
├── config → Cell<MarketConfig>
│   ├── conditionRegistry, collateralToken, jettonWallet (inline)
│   ├── conditionIds (cell ref)
│   └── outcomeSlotCounts (cell ref)
└── state → Cell<MarketState>
    ├── positionBalances (dict)
    ├── positionIds (dict)
    └── accumulatedFees (inline)
```

---

## Market Initialization

### InitMarket via transfer_notification (op = 0x7362d09c, forward_payload op = 0x10)

Initializes the market with funding collateral. This is the first operation after deployment — it transitions the market from uninitialized to running.

**Outer transfer_notification fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `op` | `uint32` | 32 bits | Fixed: `0x7362d09c` (transfer_notification) |
| `queryId` | `uint64` | 64 bits | Query identifier |
| `amount` | `coins` | variable | Amount of Jettons transferred (initial funding) |
| `sender` | `address` | 267 bits | Original sender (market deployer) |
| `forward_payload` | `cell` (ref) | reference | Contains InitMarket parameters |

**Forward payload (OP_INIT_MARKET = 0x10) fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `op` | `uint32` | 32 bits | Fixed: `0x10` |
| `conditionRegistry` | `address` | 267 bits | ConditionRegistry contract address |
| `conditionCount` | `uint8` | 8 bits | Number of conditions in this market |
| `conditionIds` | `cell` (ref) | reference | Cell containing `conditionCount` uint256 condition IDs |
| `outcomeSlotCounts` | `cell` (ref) | reference | Cell containing `conditionCount` uint8 outcome slot counts |

**Preconditions:**

- `stage == 255` (uninitialized); throws `MarketAlreadyInitialized` (301) otherwise
- `amount > 0`; throws `ZeroFunding` (302) otherwise
- Message sender must be the configured `jettonWallet`; throws `InvalidMessage` (0xFFFF) otherwise

**Step-by-step behavior:**

1. Parse outer `transfer_notification`: extract `amount`, `sender`, `forward_payload`
2. Load `MarketStorage` and verify sender is `config.jettonWallet`
3. Parse forward payload: read op (must be `0x10`), `conditionRegistry`, `conditionCount`, `conditionIds` cell, `outcomeSlotCounts` cell
4. Assert `stage == 255` (market is uninitialized)
5. Assert `amount > 0` (non-zero funding)
6. Compute `atomicOutcomeSlotCount` as the **product** of all per-condition outcome slot counts:
   ```
   atomicOutcomeSlotCount = outcomeSlotCounts[0] × outcomeSlotCounts[1] × ... × outcomeSlotCounts[n-1]
   ```
7. Set `stage = 0` (Running)
8. Set `funding = amount` (the transferred Jetton amount becomes the LMSR b parameter)
9. Set `atomicOutcomeSlotCount` to the computed value
10. Update config with the `conditionRegistry` address, `conditionIds`, and `outcomeSlotCounts`
11. Save updated storage

---

## LMSR Cost Function

The contract implements the Logarithmic Market Scoring Rule cost function for pricing trades.

### Formula

```
C(q) = b × ln(Σ exp(qᵢ / b))
```

Where:
- `b` = funding parameter (liquidity depth)
- `qᵢ` = position balance for outcome i
- The sum runs over all atomic outcomes (i = 0 to atomicOutcomeSlotCount - 1)

### Q64.64 Fixed-Point Representation

All intermediate calculations use Q64.64 fixed-point arithmetic:
- **ONE** = 2^64 = 18,446,744,073,709,551,616 (represents 1.0)
- Integer part: upper 64 bits
- Fractional part: lower 64 bits

### 5-Step Computation Sequence

The `lmsrCost` function computes C(q) in log2 space to avoid direct exponentiation overflow:

**Step 1: Compute log2-scaled values**

For each outcome i, compute:
```
log2_scaled[i] = balance_i × LOG2_E / funding
```

This is equivalent to `qᵢ × log₂(e) / b` in Q64.64, transforming the natural exponent into base-2 for use with `fixed_pow2`.

**Step 2: Find maximum**

Find the maximum value among all `log2_scaled[i]` values:
```
maxLog2Scaled = max(log2_scaled[0], log2_scaled[1], ..., log2_scaled[n-1])
```

**Step 3: Compute offset (overflow prevention)**

If `maxLog2Scaled > EXP_LIMIT` (where EXP_LIMIT ≈ 3.4 × ONE):
```
offset = maxLog2Scaled - EXP_LIMIT
```

Otherwise `offset = 0`. The offset subtracts from each exponent argument to keep all values within the safe range of `fixed_pow2`, preventing overflow in the Taylor series approximation.

**Step 4: Sum pow2 of offset-adjusted values**

```
sumExp = Σ pow2(log2_scaled[i] - offset)
```

Each term computes `2^(log2_scaled[i] - offset)` using the `fixed_pow2` function. Since the offset was subtracted, all exponent arguments are ≤ EXP_LIMIT, ensuring no overflow.

**Step 5: Compute final cost**

```
log2Sum = fixed_log2(sumExp)
totalLog2 = log2Sum + offset          // Recombine the offset
lnSum = (totalLog2 × LN_2) >> 64     // Convert log2 to ln: ln(x) = log2(x) × ln(2)
cost = lnSum × funding               // C(q) = b × ln(sum) in Q64.64
```

The offset is added back to `log2Sum` after the summation, restoring the correct magnitude. The final multiplication by `funding` gives the cost in Q64.64 scaled token units.

---

## Trade Execution

### Buy Trade via transfer_notification (op = 0x7362d09c, forward_payload op = 0x11)

Buy trades arrive as Jetton transfers — the trader sends collateral to buy outcome positions.

**Forward payload (OP_TRADE = 0x11) fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `op` | `uint32` | 32 bits | Fixed: `0x11` |
| `outcomeTokenAmounts` | `cell` (ref) | reference | Cell containing `atomicOutcomeSlotCount` int64 values (trade amounts per outcome) |
| `collateralLimit` | `int128` | 128 bits | Maximum acceptable total cost (0 = no limit) |

**Step-by-step behavior:**

1. Assert `stage == STAGE_RUNNING` (0); throw `MarketNotRunning` (303) otherwise
2. Parse `outcomeTokenAmounts` cell and `collateralLimit` from forward payload
3. Validate that the number of int64 values in `outcomeTokenAmounts` equals `atomicOutcomeSlotCount`; throw `InvalidTradeAmounts` (306) otherwise
4. Load `MarketState`
5. Compute `netCost = calcNetCost(positionBalances, tradeAmountsCell, atomicOutcomeSlotCount, funding)`:
   - `netCost = (C(q_after) - C(q_before)) / ONE`
   - Result is in raw token units (positive = trader pays)
6. Compute fee: `fee = abs(netCost) × feeRate / 10^18`
7. Compute total cost: `totalCost = netCost + fee`
8. If `collateralLimit > 0`: assert `totalCost <= collateralLimit`; throw `CollateralLimitExceeded` (307) otherwise
9. Assert `amount >= totalCost`; throw `InsufficientCollateral` (308) otherwise
10. Update position balances: for each i, `positionBalances[i] += tradeAmounts[i]`
11. Accumulate fee: `accumulatedFees += fee`
12. Save updated state

### Sell Trade (op = 0x12, direct message)

Sell trades are sent directly to the contract (not via Jetton transfer) since the trader is returning outcome positions.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier |
| `outcomeTokenAmounts` | `cell` (ref) | reference | Cell containing `atomicOutcomeSlotCount` int64 values (trade amounts per outcome) |
| `minCollateralReturn` | `coins` | variable | Minimum acceptable collateral return (reserved) |

**Step-by-step behavior:**

1. Assert `stage == STAGE_RUNNING` (0); throw `MarketNotRunning` (303) otherwise
2. Validate that the number of int64 values in `outcomeTokenAmounts` equals `atomicOutcomeSlotCount`; throw `InvalidTradeAmounts` (306) otherwise
3. Load `MarketState`
4. Compute `netCost = calcNetCost(positionBalances, tradeAmountsCell, atomicOutcomeSlotCount, funding)`:
   - For sell trades, `netCost` will be negative (trader receives collateral)
5. Compute fee: `fee = abs(netCost) × feeRate / 10^18`
6. Update position balances: for each i, `positionBalances[i] += tradeAmounts[i]`
7. Accumulate fee: `accumulatedFees += fee`
8. Save updated state

### Net Cost Computation (calcNetCost)

```
netCost = (C(q_after) - C(q_before)) / ONE
```

Where:
- `q_before[i] = positionBalances[i]` (current balances)
- `q_after[i] = positionBalances[i] + tradeAmounts[i]` (balances after trade)
- `C(q_before)` and `C(q_after)` are both computed via `lmsrCost` in Q64.64
- Division by `ONE` (2^64) converts from Q64.64 back to raw token units

### Fee Computation

```
fee = abs(netCost) × feeRate / FEE_RANGE
```

Where:
- `FEE_RANGE = 10^18` (fee denominator constant)
- `feeRate` is stored in `MarketStorage.fee` (uint64, 0 to 10^18)
- A `feeRate` of `10^18` corresponds to 100% fee; `10^16` corresponds to 1% fee

### Gas Requirement

All incoming messages must carry at least **0.2 TON** (200,000,000 nanotons):

```
assert(in.valueCoins >= 200000000) throw MarketErrors.InsufficientGas
```

---

## Lifecycle Operations

### Pause (op = 0x13)

Pauses an active market, preventing new trades.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier |

**State transition:** Running (0) → Paused (1)

**Preconditions:**
- Sender must be `owner`; throws `NotOwner` (300) otherwise
- `stage` must be `STAGE_RUNNING` (0); throws `MarketNotRunning` (303) otherwise

---

### Resume (op = 0x14)

Resumes a paused market, allowing trades again.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier |

**State transition:** Paused (1) → Running (0)

**Preconditions:**
- Sender must be `owner`; throws `NotOwner` (300) otherwise
- `stage` must be `STAGE_PAUSED` (1); throws `MarketNotPaused` (304) otherwise

---

### Close (op = 0x15)

Permanently closes the market. This is irreversible.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier |

**State transition:** Running (0) or Paused (1) → Closed (2)

**Preconditions:**
- Sender must be `owner`; throws `NotOwner` (300) otherwise
- `stage` must NOT be `STAGE_CLOSED` (2); throws `MarketClosed` (305) otherwise

---

## Admin Operations

### ChangeFee (op = 0x16)

Updates the trading fee rate.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier |
| `newFee` | `uint64` | 64 bits | New fee rate (0 to FEE_RANGE) |

**Preconditions:**
- Sender must be `owner`; throws `NotOwner` (300) otherwise
- `stage` must NOT be `STAGE_CLOSED` (2); throws `MarketClosed` (305) otherwise

**Behavior:** Sets `storage.fee = newFee`

---

### ChangeFunding (op = 0x17)

Adjusts the LMSR funding (liquidity) parameter. Only allowed when market is paused.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier |
| `fundingChange` | `int128` | 128 bits | Signed change to apply to funding (positive = increase, negative = decrease) |

**Preconditions:**
- Sender must be `owner`; throws `NotOwner` (300) otherwise
- `stage` must be `STAGE_PAUSED` (1); throws `MarketNotPaused` (304) otherwise
- `fundingChange` must not be 0; throws `ZeroFundingChange` (309) otherwise

**Behavior:** Sets `storage.funding = storage.funding + fundingChange`

---

### WithdrawFees (op = 0x18)

Withdraws accumulated trading fees and resets the fee counter.

**Message struct fields:**

| Field | Type | Bit-width | Purpose |
|-------|------|-----------|---------|
| `queryId` | `uint64` | 64 bits | Query identifier |

**Preconditions:**
- Sender must be `owner`; throws `NotOwner` (300) otherwise
- `stage` must NOT be `STAGE_CLOSED` (2); throws `MarketClosed` (305) otherwise

**Behavior:** Resets `state.accumulatedFees = 0`

---

## Get-Methods

### owner()

Returns the contract owner address.

```
get fun owner(): address
```

**Returns:** The `owner` field from `MarketStorage`.

---

### stage()

Returns the current market lifecycle stage.

```
get fun stage(): int
```

**Returns:** Integer stage value:
- `0` = Running
- `1` = Paused
- `2` = Closed
- `255` = Uninitialized (before InitMarket)

---

### funding()

Returns the current LMSR funding (b) parameter.

```
get fun funding(): int
```

**Returns:** The `funding` field from `MarketStorage` (uint128 value as int).

---

### calcMarginalPrice(outcomeIndex: int)

Computes the current marginal price for a specific outcome.

```
get fun calcMarginalPrice(outcomeIndex: int): int
```

**Parameters:**
- `outcomeIndex` — The atomic outcome index (0 to atomicOutcomeSlotCount - 1)

**Formula:**

```
price_i = exp(qᵢ / b) / Σ exp(qⱼ / b)
```

**Computation (log2-space offset technique):**

1. For each outcome j, compute `log2_scaled[j] = balance_j × LOG2_E / funding`
2. Find `maxLog2Scaled` across all outcomes
3. If `maxLog2Scaled > EXP_LIMIT`: set `offset = maxLog2Scaled - EXP_LIMIT`
4. For each outcome j: compute `expVal[j] = pow2(log2_scaled[j] - offset)`
5. Compute `sumExp = Σ expVal[j]` and capture `expOutcome = expVal[outcomeIndex]`
6. Return `fixed_div(expOutcome, sumExp)` = `(expOutcome << 64) / sumExp`

**Returns:** Price in Q64.64 fixed-point format, where `ONE = 2^64 = 18,446,744,073,709,551,616` represents 1.0. All marginal prices sum to ONE (within rounding error).

---

### getNetCost(tradeAmounts: cell)

Computes the net cost of a hypothetical trade without executing it.

```
get fun getNetCost(tradeAmounts: cell): int
```

**Parameters:**
- `tradeAmounts` — Cell containing `atomicOutcomeSlotCount` int64 values (one per outcome)

**Returns:** Net cost in raw token units (positive = trader pays, negative = trader receives). Computed as `(C(q_after) - C(q_before)) / ONE`.

---

## Error Codes

All errors are defined in the `MarketErrors` enum:

| Code | Name | Trigger Condition |
|------|------|-------------------|
| 300 | `NotOwner` | Sender is not the contract owner (applies to Pause, Resume, Close, ChangeFee, ChangeFunding, WithdrawFees) |
| 301 | `MarketAlreadyInitialized` | InitMarket called when `stage != 255` (market already initialized) |
| 302 | `ZeroFunding` | InitMarket called with `amount == 0` (no collateral transferred) |
| 303 | `MarketNotRunning` | Trade or Pause attempted when `stage != 0` (market is not in Running state) |
| 304 | `MarketNotPaused` | Resume or ChangeFunding attempted when `stage != 1` (market is not in Paused state) |
| 305 | `MarketClosed` | Close, ChangeFee, or WithdrawFees attempted when `stage == 2` (market is permanently closed) |
| 306 | `InvalidTradeAmounts` | Number of int64 values in `outcomeTokenAmounts` cell does not equal `atomicOutcomeSlotCount` |
| 307 | `CollateralLimitExceeded` | Buy trade total cost exceeds the specified `collateralLimit` (when `collateralLimit > 0`) |
| 308 | `InsufficientCollateral` | Buy trade Jetton `amount` is less than the computed `totalCost` (netCost + fee) |
| 309 | `ZeroFundingChange` | ChangeFunding called with `fundingChange == 0` (no-op change) |
| 310 | `InsufficientGas` | Message value is less than 0.2 TON (200,000,000 nanotons) |
| 0xFFFF | `InvalidMessage` | Unrecognized op-code; `transfer_notification` sender is not the configured Jetton wallet; forward_payload op is neither `OP_INIT_MARKET` (0x10) nor `OP_TRADE` (0x11) |
