import "@acton/io"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/scripts"

import "@wrappers/ConditionRegistry.gen"
import "@wrappers/LmsrMarketMaker.gen"

/// Deploy the Condition Registry and LMSR Market Maker contracts.
///
/// Flow:
/// 1. Deploy Condition Registry (with deployer as owner and jetton wallet placeholder)
/// 2. Deploy LMSR Market Maker (uninitialized — stage 255, ready for init_market)
///
/// After deployment, the Market Maker is initialized by sending a Jetton transfer
/// with an init_market forward_payload (done off-chain or via a separate script).
fun main() {
    val deployer = scripts.wallet("deployer");

    println("Deployer address: {}", deployer.address);
    println("");

    // ─── Step 1: Deploy Condition Registry ────────────────────────────────────

    // The jetton wallet address is a placeholder for now.
    // In production, this should be the actual Jetton wallet address
    // of the Condition Registry contract (determined after deploying the
    // collateral token's Jetton master and computing the wallet address).
    val registryData = beginCell()
        .storeAddress(deployer.address)   // owner
        .storeAddress(deployer.address)   // jettonWallet (placeholder)
        .storeDict(null)                  // conditions (empty)
        .storeDict(null)                  // balances (empty)
        .endCell();

    val registryStateInit = ContractState {
        code: build("ConditionRegistry"),
        data: registryData,
    };
    val registryAddress = AutoDeployAddress { stateInit: registryStateInit }.calculateAddress();
    val registry = ConditionRegistry { address: registryAddress, stateInit: registryStateInit };
    val registryResult = registry.deploy(deployer.address, { value: ton("0.15") });
    if (registryResult.waitForFirstTransaction() == null) {
        println("ERROR: Condition Registry deployment failed");
        return;
    }

    println("✓ Condition Registry deployed to: {}", registry.address);
    println("  Owner: {}", registry.owner());
    println("");

    // ─── Step 2: Deploy LMSR Market Maker ─────────────────────────────────────

    // The Market Maker starts in stage 255 (uninitialized).
    // It must be initialized by sending a Jetton transfer_notification
    // with an init_market payload containing:
    //   - condition registry address
    //   - condition IDs
    //   - outcome slot counts
    //   - funding amount (as Jetton transfer amount)
    val mmData = beginCell()
        .storeAddress(deployer.address)   // owner
        .storeUint(0, 32)                 // atomicOutcomeSlotCount
        .storeUint(0, 128)                // funding
        .storeUint(0, 64)                 // fee
        .storeUint(255, 8)                // stage (255 = uninitialized)
        .storeRef(beginCell()             // config (MarketConfig)
            .storeAddress(registry.address)   // conditionRegistry
            .storeAddress(deployer.address)   // collateralToken (placeholder)
            .storeAddress(deployer.address)   // jettonWallet (placeholder)
            .storeRef(beginCell().endCell())   // conditionIds (empty)
            .storeRef(beginCell().endCell())   // outcomeSlotCounts (empty)
            .endCell())
        .storeRef(beginCell()             // state (MarketState)
            .storeDict(null)    // positionBalances
            .storeDict(null)    // positionIds
            .storeUint(0, 128)  // accumulatedFees
            .endCell())
        .endCell();

    val mmStateInit = ContractState {
        code: build("LmsrMarketMaker"),
        data: mmData,
    };
    val mmAddress = AutoDeployAddress { stateInit: mmStateInit }.calculateAddress();
    val mm = LmsrMarketMaker { address: mmAddress, stateInit: mmStateInit };
    val mmResult = mm.deploy(deployer.address, { value: ton("0.15") });
    if (mmResult.waitForFirstTransaction() == null) {
        println("ERROR: LMSR Market Maker deployment failed");
        return;
    }

    println("✓ LMSR Market Maker deployed to: {}", mm.address);
    println("  Owner: {}", mm.owner());
    println("  Stage: {} (255 = uninitialized)", mm.stage());
    println("");

    // ─── Summary ──────────────────────────────────────────────────────────────

    println("═══════════════════════════════════════════════════");
    println("  Deployment Complete");
    println("═══════════════════════════════════════════════════");
    println("  Condition Registry: {}", registry.address);
    println("  LMSR Market Maker:  {}", mm.address);
    println("");
    println("  Next steps:");
    println("  1. Deploy collateral Jetton master");
    println("  2. Compute Jetton wallet addresses for both contracts");
    println("  3. Update Jetton wallet addresses (or redeploy with correct ones)");
    println("  4. Initialize the Market Maker via Jetton transfer with init_market payload");
}
