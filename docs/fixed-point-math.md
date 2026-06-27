# Fixed-Point Math Library Reference

> **Contract version:** v0.1.0  
> **Acton CLI:** 1.1.0  
> **Source:** `contracts/src/fixed_math.tolk`

This document describes the Q64.64 fixed-point math library used by the LmsrMarketMaker contract for LMSR pricing calculations. All intermediate arithmetic in cost function evaluation, marginal price computation, and trade net-cost calculations is performed in this fixed-point format.

---

## Table of Contents

1. [Q64.64 Representation](#q6464-representation)
2. [Constants](#constants)
3. [Function Reference](#function-reference)
4. [Taylor Series Approximation (fixed_pow2)](#taylor-series-approximation-fixed_pow2)
5. [Error Codes](#error-codes)
6. [Overflow Prevention Technique](#overflow-prevention-technique)

---

## Q64.64 Representation

### Format Definition

Q64.64 is a signed fixed-point number format that uses a 257-bit TVM integer to store values with 64 integer bits and 64 fractional bits.

```
┌──────────────────────────────────────────────────────────────────┐
│  Sign  │     Integer Part (64 bits)    │  Fractional Part (64 bits)  │
└──────────────────────────────────────────────────────────────────┘
```

- **Integer bits:** 64 (upper portion after sign)
- **Fractional bits:** 64 (lower portion)
- **Unit constant (ONE):** 2^64 = `18446744073709551616`

A Q64.64 value `v` represents the real number `v / ONE = v / 2^64`.

### ONE Constant

```
ONE = 2^64 = 18446744073709551616
```

The value `ONE` represents exactly `1.0` in Q64.64 format. It is the multiplicative identity for fixed-point operations — any value multiplied by ONE (via `fixed_mul`) returns itself.

### Representable Value Range

| Property | Value |
|----------|-------|
| Minimum positive value | 1 (represents 2^-64 ≈ 5.42 × 10^-20) |
| Maximum positive value | Limited by TVM integer precision (257-bit signed) |
| Smallest magnitude | 2^-64 ≈ 5.421 × 10^-20 |
| Resolution (ULP) | 2^-64 ≈ 5.421 × 10^-20 |
| ONE | 18446744073709551616 (represents 1.0) |
| 2 × ONE | 36893488147419103232 (represents 2.0) |

Since TVM integers are 257-bit signed, the effective integer part can represent extremely large values, but the practical domain is constrained by the LMSR computations which operate on values that fit within exponential/logarithmic ranges.

---

## Constants

### LOG2_E — Binary Logarithm of Euler's Number

| Property | Value |
|----------|-------|
| Mathematical definition | log₂(e) ≈ 1.4426950408889634 |
| Q64.64 encoded value | `26613026195688644984` |
| Derivation | ⌊log₂(e) × 2^64⌋ |

**Used in LMSR computation:** Step 1 of `lmsrCost` — converting natural-scale quantities to log2-space. Each position balance `q_i` is multiplied by `LOG2_E` and divided by the funding parameter `b` to produce the log2-scaled exponent argument:

```
log2_scaled[i] = q_i * LOG2_E / funding
```

This converts the natural exponential `exp(q_i / b)` into the equivalent base-2 computation `pow2(q_i * log2(e) / b)`, which is more efficient to compute in binary fixed-point.

### LN_2 — Natural Logarithm of 2

| Property | Value |
|----------|-------|
| Mathematical definition | ln(2) ≈ 0.6931471805599453 |
| Q64.64 encoded value | `12786308645202655660` |
| Derivation | ⌊ln(2) × 2^64⌋ |

**Used in LMSR computation:** Step 5 of `lmsrCost` — converting the log2-space result back to natural logarithm. After computing `log2(Σ pow2(...))`, the result is multiplied by `LN_2` to obtain `ln(Σ exp(...))`:

```
lnSum = (totalLog2 * LN_2) >> 64
```

Also used in `fixed_ln` to convert base-2 logarithm to natural logarithm: `ln(x) = log2(x) × ln(2)`.

### EXP_LIMIT — Maximum Safe Exponent for pow2

| Property | Value |
|----------|-------|
| Mathematical definition | ~3.4 × ONE (maximum safe 2^x argument before overflow risk) |
| Q64.64 encoded value | `62771017353866807638` |
| Approximate real value | 62771017353866807638 / 2^64 ≈ 3.402 |

**Used in LMSR computation:** Step 3 of `lmsrCost` — determining whether the offset technique must be applied. When the maximum log2-scaled value exceeds `EXP_LIMIT`, all exponent arguments are reduced by `(max - EXP_LIMIT)` to prevent `fixed_pow2` from operating on values that would overflow or lose precision:

```
if (maxLog2Scaled > EXP_LIMIT) {
    offset = maxLog2Scaled - EXP_LIMIT;
}
```

This threshold represents `2^3.402 ≈ 10.6`, meaning individual `pow2` calls are capped at producing values no larger than approximately 10.6 × ONE before summation.

---

## Function Reference

### fixed_mul(a, b) → int

**Fixed-point multiplication.**

| Property | Description |
|----------|-------------|
| Signature | `fun fixed_mul(a: int, b: int): int` |
| Operation | `(a * b) >> 64` |
| Input domain | Any Q64.64 values (TVM 257-bit integers) |
| Output format | Q64.64 |
| Precision | Exact for products that fit in TVM integer range; truncation toward zero from the right-shift |
| Approximation error | ≤ 1 ULP (one unit in the last place, i.e., 2^-64) due to truncation |

**Behavior:** Multiplies two Q64.64 values and normalizes the result by shifting right 64 bits. Since both inputs encode `a/2^64` and `b/2^64`, their product `a*b` is scaled by `2^128`, and the shift produces a correctly-scaled Q64.64 result.

### fixed_div(a, b) → int

**Fixed-point division.**

| Property | Description |
|----------|-------------|
| Signature | `fun fixed_div(a: int, b: int): int` |
| Operation | `(a << 64) / b` |
| Input domain | Any Q64.64 values; `b ≠ 0` |
| Output format | Q64.64 |
| Precision | Exact for quotients that fit; truncation toward zero from integer division |
| Approximation error | ≤ 1 ULP due to integer division truncation |
| Error condition | Throws `400` if `b == 0` |

**Behavior:** Divides `a` by `b` in Q64.64. The dividend is pre-shifted left by 64 bits to maintain precision, then integer division produces the correctly-scaled result.

### fixed_log2(x) → int

**Binary logarithm in Q64.64.**

| Property | Description |
|----------|-------------|
| Signature | `fun fixed_log2(x: int): int` |
| Operation | Returns log₂(x) where x is in Q64.64 |
| Input domain | `x > 0` (Q64.64 representation of a positive real number) |
| Output format | Q64.64 (can be negative for x < ONE) |
| Precision | 64 fractional bits of precision via iterative squaring |
| Approximation error | ≤ 1 ULP; the iterative squaring method produces one bit of precision per iteration across 64 iterations |
| Error condition | Throws `401` if `x ≤ 0` |

**Algorithm:**
1. **Integer part:** Normalize `x` into the range `[ONE, 2×ONE)` by shifting, counting the number of shifts as the integer part of the logarithm.
2. **Fractional part:** Perform 64 iterations of squaring. At each step, square the normalized value. If the result exceeds `2×ONE`, shift right and record a `1` bit at the current fractional position.

### fixed_pow2(x) → int

**Power of two in Q64.64.**

| Property | Description |
|----------|-------------|
| Signature | `fun fixed_pow2(x: int): int` |
| Operation | Returns 2^x where x is in Q64.64 |
| Input domain | Any Q64.64 value (handles negative exponents) |
| Output format | Q64.64 |
| Precision | 9-term Taylor series provides ~18+ decimal digits of precision for the fractional part |
| Approximation error | < 1 ULP for typical LMSR inputs (fractional part in [0, 1)); error grows for very large integer parts due to left-shift amplification |

**Algorithm:**
1. Split `x` into integer part and fractional part: `intPart = absX >> 64`, `fracPart = absX & ((1<<64) - 1)`
2. Compute `2^fracPart` using a 9-term Taylor/Maclaurin series with Horner's method (see [Taylor Series section](#taylor-series-approximation-fixed_pow2))
3. Combine: `result = fracResult << intPart` (left-shift by integer part multiplies by the corresponding power of 2)
4. If the original exponent was negative: `result = (ONE << 64) / result`

### fixed_ln(x) → int

**Natural logarithm in Q64.64.**

| Property | Description |
|----------|-------------|
| Signature | `fun fixed_ln(x: int): int` |
| Operation | Returns ln(x) = log₂(x) × ln(2) |
| Input domain | `x > 0` (Q64.64) |
| Output format | Q64.64 |
| Precision | Inherits precision from `fixed_log2` (≤ 1 ULP) plus truncation from `fixed_mul` |
| Approximation error | ≤ 2 ULP (composition of log2 error + multiplication truncation) |
| Error condition | Throws `401` if `x ≤ 0` (propagated from `fixed_log2`) |

**Implementation:** Computes `fixed_mul(fixed_log2(x), LN_2)`. The change-of-base formula `ln(x) = log₂(x) × ln(2)` is applied using the pre-computed `LN_2` constant.

### fixed_exp(x) → int

**Natural exponential in Q64.64.**

| Property | Description |
|----------|-------------|
| Signature | `fun fixed_exp(x: int): int` |
| Operation | Returns e^x = 2^(x × log₂(e)) |
| Input domain | Any Q64.64 value where the result fits in TVM integers |
| Output format | Q64.64 |
| Precision | Inherits precision from `fixed_pow2` plus truncation from `fixed_mul` |
| Approximation error | ≤ 2 ULP for typical inputs |

**Implementation:** Computes `fixed_pow2(fixed_mul(x, LOG2_E))`. The identity `e^x = 2^(x × log₂(e))` reduces natural exponentiation to base-2 exponentiation.

### fixed_max(arr) → int

**Maximum element of a cell-encoded integer array.**

| Property | Description |
|----------|-------------|
| Signature | `fun fixed_max(arr: cell): int` |
| Operation | Returns the maximum value from a cell storing count (uint32) followed by count int257 values |
| Input domain | Cell with at least 1 element (count > 0) |
| Output format | Raw integer (same format as stored values) |
| Error condition | Throws `402` if count == 0 (empty array) |

---

## Taylor Series Approximation (fixed_pow2)

The `fixed_pow2` function uses a 9-term Taylor/Maclaurin series to approximate `2^f` for the fractional part `f ∈ [0, 1)`.

### Mathematical Basis

The Taylor series expansion of `2^f` around `f = 0`:

```
2^f = e^(f × ln(2)) = Σ (f × ln(2))^k / k!  for k = 0, 1, 2, ...
```

Rearranging, the k-th coefficient is:

```
c_k = ln(2)^k / k!   (in Q64.64 format)
```

The series is truncated at 9 terms (k = 1 through k = 9), with the k = 0 term being `ONE` (added at the end of the Horner evaluation).

### Coefficients

| Coefficient | Formula | Q64.64 Value | Approximate Real Value |
|-------------|---------|--------------|----------------------|
| c1 | ln(2)^1 / 1! | `12786308645202655660` | 0.693147180559945 |
| c2 | ln(2)^2 / 2! | `4431396893595737425` | 0.240226506959101 |
| c3 | ln(2)^3 / 3! | `1023870087579328453` | 0.055504108664822 |
| c4 | ln(2)^4 / 4! | `177423166116318949` | 0.009618129107629 |
| c5 | ln(2)^5 / 5! | `24596073471909060` | 0.001333355814497 |
| c6 | ln(2)^6 / 6! | `2841449829983171` | 0.000154035303933 |
| c7 | ln(2)^7 / 7! | `281363276907910` | 0.000015252733804 |
| c8 | ln(2)^8 / 8! | `24378270262728` | 0.000001321543920 |
| c9 | ln(2)^9 / 9! | `1877525477726` | 0.000000101780860 |

**Note:** c1 equals `LN_2` since ln(2)^1 / 1! = ln(2).

### Horner's Method Evaluation Order

The polynomial is evaluated using Horner's method (nested multiplication) to minimize the number of multiplications and maintain precision:

```
2^f = ONE + f × (c1 + f × (c2 + f × (c3 + f × (c4 + f × (c5 + f × (c6 + f × (c7 + f × (c8 + f × c9))))))))
```

In code, this evaluates from the innermost coefficient outward:

```
fracResult = c9
fracResult = c8 + (fracResult × fracPart) >> 64
fracResult = c7 + (fracResult × fracPart) >> 64
fracResult = c6 + (fracResult × fracPart) >> 64
fracResult = c5 + (fracResult × fracPart) >> 64
fracResult = c4 + (fracResult × fracPart) >> 64
fracResult = c3 + (fracResult × fracPart) >> 64
fracResult = c2 + (fracResult × fracPart) >> 64
fracResult = c1 + (fracResult × fracPart) >> 64
fracResult = ONE + (fracResult × fracPart) >> 64
```

Each step multiplies the accumulator by the fractional part (in Q64.64, hence `>> 64` normalization) and adds the next coefficient. Starting from `c9` and working toward `c1` ensures numerical stability by accumulating smaller terms first.

### Precision Analysis

For `f ∈ [0, 1)`:
- The 10th term (k = 10) would be `ln(2)^10 / 10! ≈ 7.05 × 10^-9`, which is below the Q64.64 resolution for values near 1.0.
- The 9-term approximation provides relative error < 10^-18 for the fractional part, well within 1 ULP.
- The dominant error source is the truncation from each `>> 64` shift operation (up to 9 × 1 ULP accumulated).

---

## Error Codes

The math library asserts domain constraints and throws specific error codes on violation:

| Code | Name | Trigger Condition | Function |
|------|------|-------------------|----------|
| 400 | Division by zero | `b == 0` in `fixed_div(a, b)` | `fixed_div` |
| 401 | Non-positive logarithm input | `x ≤ 0` in logarithm functions | `fixed_log2`, `fixed_ln` |
| 402 | Empty array | `count == 0` in cell-encoded array | `fixed_max` |

### Assertion Behavior

All domain violations use the Tolk `assert(...) throw <code>` pattern. When the assertion condition is false, the contract transaction is aborted with the specified exit code. No state changes are persisted on assertion failure.

```tolk
assert(b != 0) throw 400;   // fixed_div
assert(x > 0) throw 401;    // fixed_log2, fixed_ln
assert(count > 0) throw 402; // fixed_max
```

These codes are distinct from the ConditionRegistry errors (100–210) and MarketMaker errors (300–310), avoiding collision in diagnostic output.

---

## Overflow Prevention Technique

### Problem Statement

The LMSR cost function computes `C(q) = b × ln(Σ exp(q_i / b))`. When position balances `q_i` grow large relative to the funding parameter `b`, the intermediate values `exp(q_i / b)` can overflow the representable fixed-point range. Even with TVM's 257-bit integers, large exponents produce values that lose precision in subsequent log/division operations.

### Solution: Log2-Space Offset Method

The `lmsrCost` function in `lmsr_market_maker.tolk` uses an offset technique that operates entirely in log2-space to keep intermediate `pow2` calls within safe bounds.

#### Step-by-Step Process

**Step 1 — Compute log2-scaled values:**

For each outcome `i`, compute the log2-space representation of the exponent:

```
log2_scaled[i] = q_i × LOG2_E / funding
```

This converts `exp(q_i / b)` into `pow2(log2_scaled[i])` using the identity `e^x = 2^(x × log₂(e))`.

**Step 2 — Find maximum:**

```
maxLog2Scaled = max(log2_scaled[0], log2_scaled[1], ..., log2_scaled[n-1])
```

**Step 3 — Compute offset (conditional on EXP_LIMIT threshold):**

```
if (maxLog2Scaled > EXP_LIMIT) {
    offset = maxLog2Scaled - EXP_LIMIT;
} else {
    offset = 0;
}
```

The offset is only applied when the maximum value exceeds `EXP_LIMIT` (~3.4 × ONE). This ensures that `pow2(maxLog2Scaled - offset) ≤ pow2(EXP_LIMIT)`, keeping the largest individual exponential within safe bounds.

**Step 4 — Sum offset-adjusted exponentials:**

```
sumExp = Σ pow2(log2_scaled[i] - offset)   for all i
```

Each `pow2` argument is reduced by the offset, so all arguments are ≤ EXP_LIMIT. The summation produces a Q64.64 value representing `Σ 2^(log2_scaled[i] - offset)`.

**Step 5 — Recombine offset after summation:**

```
log2Sum = fixed_log2(sumExp)
totalLog2 = log2Sum + offset
lnSum = (totalLog2 × LN_2) >> 64
cost = lnSum × funding
```

The offset that was subtracted before exponentiation is added back in log2-space after taking the logarithm of the sum. This is mathematically valid because:

```
log₂(Σ 2^(x_i - offset)) + offset = log₂(2^offset × Σ 2^(x_i - offset)) = log₂(Σ 2^x_i)
```

The final multiplication by `LN_2` converts from log2-space back to natural logarithm, and multiplication by `funding` produces the LMSR cost value.

### Why EXP_LIMIT ≈ 3.4 × ONE

The threshold `EXP_LIMIT = 62771017353866807638` represents approximately 3.4 in Q64.64. This means `pow2(EXP_LIMIT)` ≈ `2^3.4 ≈ 10.6 × ONE`. This conservative bound ensures:

1. Individual `pow2` results stay well within Q64.64 precision
2. Summation of multiple offset-adjusted exponentials (up to `atomicOutcomeSlotCount` terms) remains representable
3. Subsequent `fixed_log2` operates on a value in its well-conditioned range

### Same Technique in calcMarginalPrice

The `calcMarginalPrice` get-method uses the same offset technique to compute marginal prices:

```
price_i = 2^(log2_scaled[i] - offset) / Σ 2^(log2_scaled[j] - offset)
```

Since both numerator and denominator share the same offset, it cancels in the division, producing the correct ratio without needing to recombine.
