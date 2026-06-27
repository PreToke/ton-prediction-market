import "@acton/env"
import "@acton/io"
import "@acton/prompts"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@wrappers/JettonMinter.gen"
import "@wrappers/JettonWallet.gen"
import "@jetton/storage"
import "@jetton/messages"

/// Compute Jetton Wallet addresses for the platform contracts.
///
/// This queries the tUSDT Minter's `get_wallet_address` getter to derive
/// the Jetton Wallet addresses for:
///   - Platform wallet (deployer)
///   - Condition Registry contract
///   - LMSR Market Maker contract
///   - Any additional address you provide
///
/// Environment variables:
///   JETTON_MINTER_ADDRESS        - The deployed tUSDT minter
///   CONDITION_REGISTRY_ADDRESS   - Deployed Condition Registry
///   LMSR_MARKET_MAKER_ADDRESS    - Deployed LMSR Market Maker
///
/// Usage:
///   JETTON_MINTER_ADDRESS=kQD0SuDQWdGbIG0hbwxRtxjfSUFlunODv6fAD_801pFTjJPb \
///   CONDITION_REGISTRY_ADDRESS=kQCVTd7Sh36uqSrWREb0HJtVERfhObsag53T1_cKbVk362vb \
///   LMSR_MARKET_MAKER_ADDRESS=kQD2VJifWa8UvhVGjFex5AfrnfadIisWNXgY2sSO2nE1NsRJ \
///   acton script contracts/scripts/jetton/get-wallet-addresses.tolk --net testnet
fun main() {
    val deployer = scripts.wallet("deployer");

    // ─── Resolve minter ───────────────────────────────────────────────────────

    val minterAddr = env<address>("JETTON_MINTER_ADDRESS")
        ?? promptAddress("Enter tUSDT Minter address");
    val minter = JettonMinter { address: minterAddr };

    println("tUSDT Minter: {}", minter.address);
    println("");

    // ─── Platform wallet (deployer) ───────────────────────────────────────────

    val platformWallet = deployer.address;
    val platformJettonWallet = minter.getWalletAddress(platformWallet);
    println("PLATFORM_WALLET_ADDRESS={}",  platformWallet);
    println("PLATFORM_JETTON_WALLET_ADDRESS={}", platformJettonWallet);
    println("");

    // ─── Condition Registry ───────────────────────────────────────────────────

    val registryAddr = env<address>("CONDITION_REGISTRY_ADDRESS")
        ?? promptAddress("Enter Condition Registry address");
    val registryJettonWallet = minter.getWalletAddress(registryAddr);
    println("CONDITION_REGISTRY_ADDRESS={}", registryAddr);
    println("REGISTRY_JETTON_WALLET_ADDRESS={}", registryJettonWallet);
    println("");

    // ─── LMSR Market Maker ────────────────────────────────────────────────────

    val mmAddr = env<address>("LMSR_MARKET_MAKER_ADDRESS")
        ?? promptAddress("Enter LMSR Market Maker address");
    val mmJettonWallet = minter.getWalletAddress(mmAddr);
    println("LMSR_MARKET_MAKER_ADDRESS={}", mmAddr);
    println("LMSR_JETTON_WALLET_ADDRESS={}", mmJettonWallet);
    println("");

    // ─── Summary for .env ─────────────────────────────────────────────────────

    println("═══════════════════════════════════════════════════");
    println("  Copy these to your .env file:");
    println("═══════════════════════════════════════════════════");
    println("");
    println("USDT_JETTON_MASTER_ADDRESS={}", minter.address);
    println("PLATFORM_JETTON_WALLET_ADDRESS={}", platformJettonWallet);
    println("REGISTRY_JETTON_WALLET_ADDRESS={}", registryJettonWallet);
    println("CONDITION_REGISTRY_ADDRESS={}", registryAddr);
}
