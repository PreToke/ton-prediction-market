/// Condition Registry Contract
/// Manages conditions, positions, split/merge/redeem operations
/// for the TON Prediction Market protocol.

import "types"
import "jetton/messages"

// ─── Op-codes ───────────────────────────────────────────────────────────────

const OP_PREPARE_CONDITION: int = 0x01;
const OP_REPORT_PAYOUTS: int = 0x02;
const OP_SPLIT_POSITION: int = 0x03;
const OP_MERGE_POSITIONS: int = 0x04;
const OP_REDEEM_POSITIONS: int = 0x05;
const OP_TRANSFER_NOTIFICATION: int = 0x7362d09c;
const OP_CLAIM_UNCLAIMED: int = 0x07;

// ─── Constants ──────────────────────────────────────────────────────────────

/// Maximum allowed outcome slot count to prevent gas exhaustion in redeem loops
const MAX_OUTCOME_SLOTS: int = 64;

// ─── Error codes ────────────────────────────────────────────────────────────

enum RegistryErrors {
    NotOwner = 100
    InvalidMessage = 0xFFFF
    InvalidOutcomeCount = 200
    ConditionAlreadyExists = 201
    ConditionNotFound = 202
    ConditionAlreadyResolved = 203
    InvalidOracle = 204
    AllZeroPayouts = 205
    InvalidPartition = 206
    InsufficientBalance = 207
    ConditionNotResolved = 208
    InvalidIndexSet = 209
    InsufficientGas = 210
    ZeroPayout = 211
    InvalidCollateralToken = 212
}

// ─── Storage ────────────────────────────────────────────────────────────────

struct RegistryStorage {
    owner: address
    jettonWallet: address
    collateralToken: address                // expected collateral Jetton master address
    conditions: map<uint256, cell>          // condition_id → condition data cell
    balances: map<uint256, coins>           // balance_key (hash of positionId+user) → amount
    pendingOps: map<uint64, cell>           // queryId → pending operation restoration data
}

fun RegistryStorage.load(): RegistryStorage {
    return RegistryStorage.fromCell(contract.getData());
}

fun RegistryStorage.save(self) {
    contract.setData(self.toCell());
}

// ─── Messages ───────────────────────────────────────────────────────────────

struct (0x01) PrepareCondition {
    queryId: uint64
    oracle: address
    questionId: uint256
    outcomeSlotCount: uint8
}

struct (0x02) ReportPayouts {
    queryId: uint64
    questionId: uint256
    payoutCount: uint8
    payouts: cell
}

struct (0x04) MergePositions {
    queryId: uint64
    collateralToken: address
    parentCollectionId: uint256
    conditionId: uint256
    partitionCount: uint8
    partition: cell
    amount: coins
}

struct (0x05) RedeemPositions {
    queryId: uint64
    collateralToken: address
    parentCollectionId: uint256
    conditionId: uint256
    indexSetCount: uint8
    indexSets: cell
}

struct (0x07) ClaimUnclaimed {
    queryId: uint64
}

// ─── Contract definition ────────────────────────────────────────────────────

contract ConditionRegistry {
    author: "Hossein Boustani"
    version: "0.1.0"
    description: "Condition Registry for TON Prediction Market - manages conditions, positions, split/merge/redeem"
    storage: RegistryStorage
    incomingMessages: AllowedRegistryMessage
}

type AllowedRegistryMessage = PrepareCondition | ReportPayouts | MergePositions | RedeemPositions | ClaimUnclaimed

// ─── ID Derivation ──────────────────────────────────────────────────────────

fun get_condition_id(oracle: slice, questionId: int, outcomeSlotCount: int): int {
    val c = beginCell()
        .storeSlice(oracle)
        .storeUint(questionId, 256)
        .storeUint(outcomeSlotCount, 8)
        .endCell();
    return c.hash();
}

fun get_collection_id(parentCollectionId: int, conditionId: int, indexSet: int): int {
    val c = beginCell()
        .storeUint(parentCollectionId, 256)
        .storeUint(conditionId, 256)
        .storeUint(indexSet, 256)
        .endCell();
    return c.hash();
}

fun get_position_id(collateralToken: slice, collectionId: int): int {
    val c = beginCell()
        .storeSlice(collateralToken)
        .storeUint(collectionId, 256)
        .endCell();
    return c.hash();
}

// ─── Entry points ───────────────────────────────────────────────────────────

fun onInternalMessage(in: InMessage) {
    // Gas validation - reject if insufficient TON attached
    assert(in.valueCoins >= 100000000) throw RegistryErrors.InsufficientGas;  // 0.1 TON = 10^8 nanotons

    val msg = lazy AllowedRegistryMessage.fromSlice(in.body);

    match (msg) {
        PrepareCondition => {
            // H-01: Only owner can create conditions
            var storage = RegistryStorage.load();
            assert(in.senderAddress == storage.owner) throw RegistryErrors.NotOwner;

            // Validate outcome slot count (must be >= 2 and <= MAX_OUTCOME_SLOTS)
            assert(msg.outcomeSlotCount >= 2) throw RegistryErrors.InvalidOutcomeCount;
            assert(msg.outcomeSlotCount <= MAX_OUTCOME_SLOTS) throw RegistryErrors.InvalidOutcomeCount;

            // Compute condition_id from oracle, questionId, outcomeSlotCount
            val oracleSlice = beginCell().storeAddress(msg.oracle).endCell().beginParse();
            val conditionId = get_condition_id(oracleSlice, msg.questionId, msg.outcomeSlotCount);

            // Check that condition does not already exist
            assert(!storage.conditions.exists(conditionId)) throw RegistryErrors.ConditionAlreadyExists;

            // Build condition data cell:
            //   oracle: address
            //   question_id: uint256
            //   outcome_slot_count: uint8
            //   payout_denominator: uint256 (0 = unresolved)
            //   payout_numerators: cell reference (empty dict)
            val conditionData = beginCell()
                .storeAddress(msg.oracle)
                .storeUint(msg.questionId, 256)
                .storeUint(msg.outcomeSlotCount, 8)
                .storeUint(0, 256)
                .storeDict(null)
                .endCell();

            // Store condition in the conditions dictionary
            storage.conditions.set(conditionId, conditionData);

            // Save updated storage
            storage.save();
        }
        ReportPayouts => {
            // Load storage
            var storage = RegistryStorage.load();

            // The oracle is identified by the sender of the message.
            // Compute condition_id from (sender_address, questionId, payoutCount)
            val senderSlice = beginCell().storeAddress(in.senderAddress).endCell().beginParse();
            val conditionId = get_condition_id(senderSlice, msg.questionId, msg.payoutCount);

            // Look up the condition — if not found, throw ConditionNotFound (202)
            val lookupResult = storage.conditions.get(conditionId);
            assert(lookupResult.isFound) throw RegistryErrors.ConditionNotFound;

            // Parse existing condition data
            var cs = lookupResult.loadValue().beginParse();
            val oracle = cs.loadAddress();
            val questionId = cs.loadUint(256);
            val outcomeSlotCount = cs.loadUint(8);
            val payoutDenominator = cs.loadUint(256);

            // Check if already resolved (payout_denominator != 0)
            assert(payoutDenominator == 0) throw RegistryErrors.ConditionAlreadyResolved;

            // Parse the payouts array from the reference cell
            var payoutsSlice = msg.payouts.beginParse();
            var denominator: int = 0;
            var i: int = 0;
            while (i < msg.payoutCount) {
                val payout = payoutsSlice.loadUint(256);
                denominator += payout;
                i += 1;
            }

            // If denominator == 0 (all-zero payouts), throw AllZeroPayouts (205)
            assert(denominator != 0) throw RegistryErrors.AllZeroPayouts;

            // Store the payout numerators and update the denominator in the condition data cell
            val conditionData = beginCell()
                .storeAddress(oracle)
                .storeUint(questionId, 256)
                .storeUint(outcomeSlotCount, 8)
                .storeUint(denominator, 256)
                .storeRef(msg.payouts)
                .endCell();

            // Update condition in storage
            storage.conditions.set(conditionId, conditionData);

            // Save the updated storage
            storage.save();
        }
        MergePositions => {
            // Load storage
            var storage = RegistryStorage.load();

            // C-02 (second audit): Validate collateralToken matches expected
            assert(msg.collateralToken == storage.collateralToken) throw RegistryErrors.InvalidCollateralToken;

            // Look up the condition — throw 202 if not found
            val lookupResult = storage.conditions.get(msg.conditionId);
            assert(lookupResult.isFound) throw RegistryErrors.ConditionNotFound;

            // Parse condition data to get outcomeSlotCount
            var cs = lookupResult.loadValue().beginParse();
            cs.loadAddress(); // skip oracle
            cs.loadUint(256); // skip questionId
            val outcomeSlotCount = cs.loadUint(8);

            // Execute merge logic (H-06: sender is authenticated via in.senderAddress)
            handleMerge(storage, in.senderAddress, msg.amount, msg.collateralToken, msg.parentCollectionId, msg.conditionId, outcomeSlotCount, msg.partitionCount, msg.partition, msg.queryId);
        }
        RedeemPositions => {
            // Load storage
            var storage = RegistryStorage.load();

            // M-06 (second audit): Validate collateralToken matches expected
            assert(msg.collateralToken == storage.collateralToken) throw RegistryErrors.InvalidCollateralToken;

            // Look up the condition
            val lookupResult = storage.conditions.get(msg.conditionId);
            assert(lookupResult.isFound) throw RegistryErrors.ConditionNotFound;

            // Parse condition data
            var cs = lookupResult.loadValue().beginParse();
            cs.loadAddress(); // skip oracle
            cs.loadUint(256); // skip questionId
            val outcomeSlotCount = cs.loadUint(8);
            val payoutDenominator = cs.loadUint(256);

            // Check condition is resolved (denominator > 0)
            assert(payoutDenominator > 0) throw RegistryErrors.ConditionNotResolved;

            // Load payouts array from reference
            val payoutsRef = cs.loadRef();

            val fullIndexSet = (1 << outcomeSlotCount) - 1;
            val sender = in.senderAddress;

            // Process each index set
            var indexSetsSlice = msg.indexSets.beginParse();
            var totalPayout: int = 0;
            var i: int = 0;

            while (i < msg.indexSetCount) {
                val indexSet = indexSetsSlice.loadUint(256);

                // Validate index set: must be > 0 and < fullIndexSet
                assert(indexSet > 0) throw RegistryErrors.InvalidIndexSet;
                assert(indexSet < fullIndexSet) throw RegistryErrors.InvalidIndexSet;

                // Compute payout_numerator: sum payouts[j] for each bit j set in indexSet
                var payoutNumerator: int = 0;
                var payoutsSlice = payoutsRef.beginParse();
                var j: int = 0;
                while (j < outcomeSlotCount) {
                    val p = payoutsSlice.loadUint(256);
                    if (((indexSet >> j) & 1) == 1) {
                        payoutNumerator += p;
                    }
                    j += 1;
                }

                // Compute position's collection_id and position_id
                val collectionId = get_collection_id(msg.parentCollectionId, msg.conditionId, indexSet);
                val positionId = getPositionId(msg.collateralToken, collectionId);

                // Get trader's balance in that position
                val balance = getBalance(storage, positionId, sender);

                // Compute position_payout = balance * payout_numerator / denominator (floor division)
                val positionPayout = balance * payoutNumerator / payoutDenominator;
                totalPayout += positionPayout;

                // Burn (zero out) the trader's position balance
                storage = setBalance(storage, positionId, sender, 0);

                i += 1;
            }

            // If there's a payout and parent is non-null, mint in parent position
            if (totalPayout > 0 && msg.parentCollectionId != 0) {
                val parentPositionId = getPositionId(msg.collateralToken, msg.parentCollectionId);
                val parentBalance = getBalance(storage, parentPositionId, sender);
                storage = setBalance(storage, parentPositionId, sender, parentBalance + totalPayout);
            } else if (totalPayout > 0 && msg.parentCollectionId == 0) {
                // C-02: parentCollectionId == 0 — send collateral back to trader via Jetton transfer
                // Store pending op for bounce recovery: record amount and recipient
                val pendingData = beginCell()
                    .storeAddress(sender)
                    .storeCoins(totalPayout)
                    .storeUint(1, 8)  // op type: 1 = redeem refund
                    .endCell();
                storage.pendingOps.set(msg.queryId, pendingData);

                sendJettonTransfer(storage.jettonWallet, sender, totalPayout, msg.queryId);
            }
            // If totalPayout == 0: positions are burned (losing positions), no transfer needed

            // Save updated storage
            storage.save();
        }
        ClaimUnclaimed => {
            // Allow users to re-claim collateral that was credited back after a bounced transfer.
            var storage = RegistryStorage.load();
            val sender = in.senderAddress;

            // Look up unclaimed balance using positionId = 0 as sentinel
            val unclaimedKey = getBalanceKey(0, sender);
            val result = storage.balances.get(unclaimedKey);
            var unclaimedBalance: int = 0;
            if (result.isFound) {
                unclaimedBalance = result.loadValue();
            }
            assert(unclaimedBalance > 0) throw RegistryErrors.InsufficientBalance;

            // Zero out the unclaimed balance
            storage.balances.set(unclaimedKey, 0);

            // Store pending op for this claim (in case this transfer also bounces)
            val pendingData = beginCell()
                .storeAddress(sender)
                .storeCoins(unclaimedBalance)
                .storeUint(3, 8)  // op type: 3 = claim retry
                .endCell();
            storage.pendingOps.set(msg.queryId, pendingData);

            // Send the collateral
            sendJettonTransfer(storage.jettonWallet, sender, unclaimedBalance, msg.queryId);

            storage.save();
        }
        else => {
            // Handle transfer_notification for splits (op 0x7362d09c)
            var bodySlice = in.body;
            val op = bodySlice.loadUint(32);

            if (op == OP_TRANSFER_NOTIFICATION) {
                val _queryId = bodySlice.loadUint(64);
                val amount = bodySlice.loadCoins();
                val sender = bodySlice.loadAddress();
                val forwardPayload = bodySlice.loadRef();

                // Load storage and verify sender is our Jetton wallet
                var storage = RegistryStorage.load();
                assert(in.senderAddress == storage.jettonWallet) throw RegistryErrors.InvalidMessage;

                // Parse forward_payload (split_position parameters)
                var fpSlice = forwardPayload.beginParse();
                val fpOp = fpSlice.loadUint(32);
                assert(fpOp == OP_SPLIT_POSITION) throw RegistryErrors.InvalidMessage;

                val collateralToken = fpSlice.loadAddress();
                val parentCollectionId = fpSlice.loadUint(256);
                val conditionId = fpSlice.loadUint(256);
                val partitionCount = fpSlice.loadUint(8);
                val partitionCell = fpSlice.loadRef();

                // L-02: Validate collateralToken matches expected collateral in storage
                assert(collateralToken == storage.collateralToken) throw RegistryErrors.InvalidCollateralToken;

                // Look up the condition
                val lookupResult = storage.conditions.get(conditionId);
                assert(lookupResult.isFound) throw RegistryErrors.ConditionNotFound;

                // Parse condition data to get outcomeSlotCount
                var cs = lookupResult.loadValue().beginParse();
                cs.loadAddress(); // skip oracle
                cs.loadUint(256); // skip questionId
                val outcomeSlotCount = cs.loadUint(8);

                // Execute split logic
                handleSplit(storage, sender, amount, collateralToken, parentCollectionId, conditionId, outcomeSlotCount, partitionCount, partitionCell);
            } else {
                assert(false) throw RegistryErrors.InvalidMessage;
            }
        }
    }
}

// ─── Split Position Logic ───────────────────────────────────────────────────

fun handleSplit(
    storage: RegistryStorage,
    sender: address,
    amount: int,
    collateralToken: address,
    parentCollectionId: int,
    conditionId: int,
    outcomeSlotCount: int,
    partitionCount: int,
    partitionCell: cell,
) {
    // Validate partition: must have at least 2 index sets
    assert(partitionCount >= 2) throw RegistryErrors.InvalidPartition;

    val fullIndexSet = (1 << outcomeSlotCount) - 1;

    // Parse partition and validate
    var pSlice = partitionCell.beginParse();
    var combinedIndexSet: int = 0;
    var i: int = 0;

    // First pass: validate each index set and compute combined (union)
    // Also check for overlaps (disjoint requirement)
    while (i < partitionCount) {
        val indexSet = pSlice.loadUint(256);

        // Each index set must be > 0
        assert(indexSet > 0) throw RegistryErrors.InvalidPartition;

        // Each index set must be < full set (within bounds)
        assert(indexSet < fullIndexSet) throw RegistryErrors.InvalidPartition;

        // Check for overlap with previously seen index sets
        assert((combinedIndexSet & indexSet) == 0) throw RegistryErrors.InvalidPartition;

        combinedIndexSet |= indexSet;
        i += 1;
    }

    // Determine if this is a full-set split or partial-set split
    val isFullSetSplit = (combinedIndexSet == fullIndexSet);

    if (isFullSetSplit) {
        // Full-set split from collateral (or from parent position)
        if (parentCollectionId != 0) {
            // Deep split: burn the parent position
            val parentPositionId = getPositionId(collateralToken, parentCollectionId);
            val currentBalance = getBalance(storage, parentPositionId, sender);
            assert(currentBalance >= amount) throw RegistryErrors.InsufficientBalance;
            storage = setBalance(storage, parentPositionId, sender, currentBalance - amount);
        }
        // If parentCollectionId == 0 and full-set: collateral split — amount is the incoming Jettons

        // Mint positions for each index set in the partition
        var pSlice2 = partitionCell.beginParse();
        var j: int = 0;
        while (j < partitionCount) {
            val indexSet = pSlice2.loadUint(256);
            val collectionId = get_collection_id(parentCollectionId, conditionId, indexSet);
            val positionId = getPositionId(collateralToken, collectionId);
            val currentBalance = getBalance(storage, positionId, sender);
            storage = setBalance(storage, positionId, sender, currentBalance + amount);
            j += 1;
        }
    } else {
        // Partial-set split: burn the union position and mint sub-positions
        // The trader must hold the union position (combinedIndexSet) with sufficient balance
        val unionCollectionId = get_collection_id(parentCollectionId, conditionId, combinedIndexSet);
        val unionPositionId = getPositionId(collateralToken, unionCollectionId);
        val currentBalance = getBalance(storage, unionPositionId, sender);
        assert(currentBalance >= amount) throw RegistryErrors.InsufficientBalance;

        // Burn union position
        storage = setBalance(storage, unionPositionId, sender, currentBalance - amount);

        // Mint sub-positions
        var pSlice2 = partitionCell.beginParse();
        var j: int = 0;
        while (j < partitionCount) {
            val indexSet = pSlice2.loadUint(256);
            val collectionId = get_collection_id(parentCollectionId, conditionId, indexSet);
            val positionId = getPositionId(collateralToken, collectionId);
            val bal = getBalance(storage, positionId, sender);
            storage = setBalance(storage, positionId, sender, bal + amount);
            j += 1;
        }
    }

    // Save updated storage
    storage.save();
}

// ─── Merge Position Logic ───────────────────────────────────────────────────

fun handleMerge(
    storage: RegistryStorage,
    sender: address,
    amount: int,
    collateralToken: address,
    parentCollectionId: int,
    conditionId: int,
    outcomeSlotCount: int,
    partitionCount: int,
    partitionCell: cell,
    queryId: int,
) {
    // Validate partition: must have at least 2 index sets
    assert(partitionCount >= 2) throw RegistryErrors.InvalidPartition;

    val fullIndexSet = (1 << outcomeSlotCount) - 1;

    // Parse partition and validate
    var pSlice = partitionCell.beginParse();
    var combinedIndexSet: int = 0;
    var i: int = 0;

    // Validate each index set and compute combined (union)
    while (i < partitionCount) {
        val indexSet = pSlice.loadUint(256);

        // Each index set must be > 0
        assert(indexSet > 0) throw RegistryErrors.InvalidPartition;

        // Each index set must be < full set (within bounds)
        assert(indexSet < fullIndexSet) throw RegistryErrors.InvalidPartition;

        // Check for overlap with previously seen index sets (disjoint)
        assert((combinedIndexSet & indexSet) == 0) throw RegistryErrors.InvalidPartition;

        combinedIndexSet |= indexSet;
        i += 1;
    }

    // Determine if this is a full-set or partial-set merge
    val isFullSetMerge = (combinedIndexSet == fullIndexSet);

    // Burn each partition position (check balance >= amount, throw 207 if not)
    var pSlice2 = partitionCell.beginParse();
    var j: int = 0;
    while (j < partitionCount) {
        val indexSet = pSlice2.loadUint(256);
        val collectionId = get_collection_id(parentCollectionId, conditionId, indexSet);
        val positionId = getPositionId(collateralToken, collectionId);
        val currentBalance = getBalance(storage, positionId, sender);
        assert(currentBalance >= amount) throw RegistryErrors.InsufficientBalance;
        storage = setBalance(storage, positionId, sender, currentBalance - amount);
        j += 1;
    }

    if (isFullSetMerge) {
        if (parentCollectionId == 0) {
            // C-02: Full-set merge with null parent — collateral refund via Jetton transfer
            // Store pending op for bounce recovery
            val pendingData = beginCell()
                .storeAddress(sender)
                .storeCoins(amount)
                .storeUint(2, 8)  // op type: 2 = merge refund
                .endCell();
            storage.pendingOps.set(queryId as uint64, pendingData);

            sendJettonTransfer(storage.jettonWallet, sender, amount, queryId);
        } else {
            // Deep merge: full-set merge with non-null parent — mint the parent position
            val parentPositionId = getPositionId(collateralToken, parentCollectionId);
            val parentBalance = getBalance(storage, parentPositionId, sender);
            storage = setBalance(storage, parentPositionId, sender, parentBalance + amount);
        }
    } else {
        // Partial-set merge: mint the union position
        val unionCollectionId = get_collection_id(parentCollectionId, conditionId, combinedIndexSet);
        val unionPositionId = getPositionId(collateralToken, unionCollectionId);
        val unionBalance = getBalance(storage, unionPositionId, sender);
        storage = setBalance(storage, unionPositionId, sender, unionBalance + amount);
    }

    // Save updated storage
    storage.save();
}

// ─── Balance helpers ────────────────────────────────────────────────────────

/// Compute position_id from collateral token address and collection_id
fun getPositionId(collateralToken: address, collectionId: int): int {
    val collateralSlice = beginCell().storeAddress(collateralToken).endCell().beginParse();
    return get_position_id(collateralSlice, collectionId);
}

/// Compute a balance map key from positionId and user address
fun getBalanceKey(positionId: int, userAddress: address): int {
    val c = beginCell()
        .storeUint(positionId, 256)
        .storeAddress(userAddress)
        .endCell();
    return c.hash();
}

/// Get the balance for a given position_id and user address.
fun getBalance(storage: RegistryStorage, positionId: int, userAddress: address): int {
    val key = getBalanceKey(positionId, userAddress);
    val result = storage.balances.get(key);
    if (!result.isFound) {
        return 0;
    }
    return result.loadValue();
}

/// Set the balance for a given position_id and user address.
/// Returns updated storage.
fun setBalance(storage: RegistryStorage, positionId: int, userAddress: address, newBalance: int): RegistryStorage {
    val key = getBalanceKey(positionId, userAddress);
    storage.balances.set(key, newBalance);
    return storage;
}

// ─── Jetton Transfer Helper ─────────────────────────────────────────────────

/// Send a Jetton transfer from this contract's Jetton wallet to a recipient.
/// Used for collateral refunds (redeem with parentCollectionId == 0, full-set merge).
fun sendJettonTransfer(jettonWallet: address, recipient: address, amount: int, queryId: int) {
    val transferBody = beginCell()
        .storeUint(0x0f8a7ea5, 32)  // AskToTransfer op
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(recipient)      // transferRecipient
        .storeAddress(recipient)      // sendExcessesTo
        .storeMaybeRef(null)          // customPayload
        .storeCoins(0)                // forwardTonAmount
        .storeUint(0, 1)              // forwardPayload (empty inline)
        .endCell();

    val transferMsg = createMessage({
        bounce: true,
        dest: jettonWallet,
        value: 50000000,              // 0.05 TON for gas
        body: transferBody,
    });
    transferMsg.send(SEND_MODE_PAY_FEES_SEPARATELY);
}

fun onBouncedMessage(in: InMessageBounced) {
    // Pending-operations bounce recovery for Jetton transfers.
    // When a Jetton transfer bounces, we look up the pending op by queryId
    // and credit the amount back to the recipient (the original sender).
    in.bouncedBody.skipBouncedPrefix();
    var body = in.bouncedBody;

    if (body.remainingBitsCount() >= 32) {
        val bounceOp = body.loadUint(32);

        if (bounceOp == 0x0f8a7ea5) {
            // Jetton transfer (AskToTransfer) bounced
            if (body.remainingBitsCount() >= 64 + 4) {
                val queryId = body.loadUint(64);
                val bouncedAmount = body.loadCoins();

                // Look up pending operation
                var storage = RegistryStorage.load();
                val pendingResult = storage.pendingOps.get(queryId as uint64);

                if (pendingResult.isFound) {
                    // Restore: credit the bounced amount back as a claimable balance
                    // The pending data stores: recipient (address), amount (coins), opType (uint8)
                    var pendingSlice = pendingResult.loadValue().beginParse();
                    val recipient = pendingSlice.loadAddress();
                    val pendingAmount = pendingSlice.loadCoins();
                    val _opType = pendingSlice.loadUint(8);

                    // Credit the amount to a special "unclaimed collateral" balance for the user.
                    // We use positionId = 0 as a sentinel for unclaimed collateral refunds.
                    val unclaimedKey = getBalanceKey(0, recipient);
                    val currentUnclaimed = storage.balances.get(unclaimedKey);
                    var unclaimedBalance: int = 0;
                    if (currentUnclaimed.isFound) {
                        unclaimedBalance = currentUnclaimed.loadValue();
                    }
                    storage.balances.set(unclaimedKey, unclaimedBalance + pendingAmount);

                    // Remove the pending operation
                    storage.pendingOps.delete(queryId as uint64);

                    // Save
                    storage.save();
                }
            }
        }
    }
}

// ─── Get-methods ────────────────────────────────────────────────────────────

get fun owner(): address {
    val storage = lazy RegistryStorage.load();
    return storage.owner;
}

get fun get_condition(conditionId: int): (address, int, int, int) {
    val storage = RegistryStorage.load();
    val r = storage.conditions.get(conditionId);
    assert(r.isFound) throw RegistryErrors.ConditionNotFound;
    var cs = r.loadValue().beginParse();
    val oracle = cs.loadAddress();
    val questionId = cs.loadUint(256);
    val outcomeSlotCount = cs.loadUint(8);
    val payoutDenominator = cs.loadUint(256);
    return (oracle, questionId, outcomeSlotCount, payoutDenominator);
}

get fun compute_condition_id(oracle: slice, questionId: int, outcomeSlotCount: int): int {
    return get_condition_id(oracle, questionId, outcomeSlotCount);
}

get fun compute_collection_id(parentCollectionId: int, conditionId: int, indexSet: int): int {
    return get_collection_id(parentCollectionId, conditionId, indexSet);
}

get fun compute_position_id(collateralToken: slice, collectionId: int): int {
    return get_position_id(collateralToken, collectionId);
}

get fun get_unclaimed_balance(userAddress: address): int {
    val storage = RegistryStorage.load();
    val key = getBalanceKey(0, userAddress);
    val result = storage.balances.get(key);
    if (!result.isFound) {
        return 0;
    }
    return result.loadValue();
}
