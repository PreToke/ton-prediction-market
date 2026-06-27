import "@stdlib/strings"
import "@acton/io"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@wrappers/JettonMinter.gen"
import "@wrappers/JettonWallet.gen"
import "@jetton/storage"
import "@jetton/messages"

/// Deploy a test USDT-like Jetton on testnet for development.
///
/// This creates a mintable Jetton with:
///   Name: Test USDT
///   Symbol: tUSDT
///   Decimals: 6 (same as real USDT)
///
/// The deployer wallet becomes the admin and can mint tokens freely.
///
/// Usage:
///   acton run jetton-deploy               # emulation (local)
///   acton run jetton-deploy-testnet       # deploy to testnet
fun main() {
    val deployer = scripts.wallet("deployer");
    println("Deployer address: {}", deployer.address);
    println("");

    // ─── Build metadata ───────────────────────────────────────────────────────

    var metadata: OnchainMetadataReply = { contentDict: [] };
    metadata.contentDict.set("name".sha256(), "Test USDT".prefixWith00());
    metadata.contentDict.set("symbol".sha256(), "tUSDT".prefixWith00());
    metadata.contentDict.set("description".sha256(), "Test USDT for TON Prediction Market development".prefixWith00());
    metadata.contentDict.set("image".sha256(), "https://tether.to/images/logoCircle.png".prefixWith00());
    metadata.contentDict.set("decimals".sha256(), "6".prefixWith00());

    val storage: MinterStorage = {
        totalSupply: 0,
        adminAddress: deployer.address,
        nextAdminAddress: null,
        metadata: metadata.toCell(),
    };

    // ─── Deploy Minter ────────────────────────────────────────────────────────

    val stateInit = ContractState {
        code: build("JettonMinter"),
        data: storage.toCell(),
    };
    val minterAddress = AutoDeployAddress { stateInit }.calculateAddress();
    val minter = JettonMinter { address: minterAddress, stateInit };

    val deployMsg = createMessage({
        bounce: false,
        value: ton("0.05"),
        dest: { stateInit },
        body: TopUpTons {},
    });
    val res = net.send(deployer.address, deployMsg);
    if (res.waitForFirstTransaction() == null) {
        println("ERROR: Jetton Minter deployment failed");
        return;
    }

    println("✓ Test USDT Minter deployed");
    println("");

    // ─── Print info ───────────────────────────────────────────────────────────

    val data = minter.getJettonData();
    println("═══════════════════════════════════════════════════");
    println("  Test USDT Deployment");
    println("═══════════════════════════════════════════════════");
    println("  Minter address:  {}", minter.address);
    println("  Admin:           {}", data.adminAddress);
    println("  Total supply:    {}", data.totalSupply);
    println("  Mintable:        {}", data.mintable);
    println("");
    println("  Deployer jetton wallet: {}", minter.getWalletAddress(deployer.address));
    println("");
    println("  Next steps:");
    println("  1. Run `acton run jetton-mint-testnet` to mint tokens");
    println("  2. Use the minter address above as the collateral token");
}
