import "@stdlib/strings"
import "@acton/env"
import "@acton/io"
import "@acton/build"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@wrappers/JettonMinter.gen"
import "@wrappers/JettonWallet.gen"
import "@jetton/storage"
import "@jetton/messages"

/// Deploy test USDT and mint initial supply in one script.
///
/// This is convenient for:
///   - Local emulation testing (everything in one session)
///   - Quick testnet bootstrap (deploy + mint in one go)
///
/// Environment variables (optional):
///   MINT_RECIPIENT  - Address to receive tokens (defaults to deployer)
///   MINT_AMOUNT     - Amount in raw units (defaults to 1_000_000_000_000 = 1M tUSDT)
///
/// Usage:
///   acton run jetton-setup               # emulation
///   acton run jetton-setup-testnet       # testnet
fun main() {
    val deployer = scripts.wallet("deployer");
    println("Deployer/Admin: {}", deployer.address);
    println("");

    // ─── Step 1: Deploy Minter ────────────────────────────────────────────────

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
    val deployRes = net.send(deployer.address, deployMsg);
    if (deployRes.waitForFirstTransaction() == null) {
        println("ERROR: Jetton Minter deployment failed");
        return;
    }
    println("✓ Test USDT Minter deployed: {}", minter.address);
    println("");

    // ─── Step 2: Mint initial supply ──────────────────────────────────────────

    val recipient = env<address>("MINT_RECIPIENT") ?? deployer.address;
    val amount: coins = env<coins>("MINT_AMOUNT") ?? 1000000000000;
    println("Minting {} tUSDT to {}", amount / 1000000, recipient);

    val forwardPayload = beginCell().storeUint(0, 1).endCell().beginParse();
    val mintMsg = createMessage({
        bounce: false,
        value: ton("0.1"),
        dest: minter.address,
        body: MintNewJettons {
            queryId: 0,
            mintRecipient: recipient,
            tonAmount: ton("0.08"),
            internalTransferMsg: InternalTransferStep {
                queryId: 0,
                jettonAmount: amount,
                transferInitiator: null,
                sendExcessesTo: deployer.address,
                forwardTonAmount: 1,
                forwardPayload,
            }.toCell(),
        },
    });

    val mintRes = net.send(deployer.address, mintMsg);
    println(mintRes.waitForTrace());
    println("");

    // ─── Summary ──────────────────────────────────────────────────────────────

    val data = minter.getJettonData();
    val walletAddr = minter.getWalletAddress(recipient);
    val wallet = JettonWallet { address: walletAddr };

    println("═══════════════════════════════════════════════════");
    println("  Test USDT Setup Complete");
    println("═══════════════════════════════════════════════════");
    println("  Minter address:   {}", minter.address);
    println("  Admin:            {}", deployer.address);
    println("  Total supply:     {} tUSDT", data.totalSupply / 1000000);
    println("  Mintable:         {}", data.mintable);
    println("");
    println("  Recipient:        {}", recipient);
    println("  Recipient wallet: {}", walletAddr);
    if (scripts.isContractDeployed(walletAddr)) {
        val walletData = wallet.getWalletData();
        println("  Balance:          {} tUSDT", walletData.jettonBalance / 1000000);
    }
    println("");
    println("  To mint more tokens later:");
    println("  JETTON_MINTER_ADDRESS={} acton run jetton-mint-testnet", minter.address);
}
