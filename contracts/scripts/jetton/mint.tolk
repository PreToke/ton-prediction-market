import "@stdlib/strings"
import "@acton/env"
import "@acton/io"
import "@acton/prompts"
import "@acton/emulation/network"
import "@acton/emulation/scripts"
import "@wrappers/JettonMinter.gen"
import "@wrappers/JettonWallet.gen"
import "@jetton/storage"
import "@jetton/messages"

/// Mint test USDT tokens to a recipient address.
///
/// Environment variables (optional, prompts if not set):
///   JETTON_MINTER_ADDRESS  - The deployed test USDT minter address
///   MINT_RECIPIENT         - Recipient address (defaults to deployer)
///   MINT_AMOUNT            - Amount in micro-USDT (defaults to 1,000,000,000,000 = 1M tUSDT)
///
/// Usage:
///   acton run jetton-mint               # emulation (local)
///   acton run jetton-mint-testnet       # mint on testnet
///
/// Examples:
///   # Mint 1M tUSDT to deployer
///   acton run jetton-mint-testnet
///
///   # Mint 500k tUSDT to a specific address
///   MINT_AMOUNT=500000000000 MINT_RECIPIENT=EQxxx acton run jetton-mint-testnet
fun main() {
    val deployer = scripts.wallet("deployer");
    println("Admin (deployer): {}", deployer.address);
    println("");

    // ─── Resolve minter address ───────────────────────────────────────────────

    val minterAddr = env<address>("JETTON_MINTER_ADDRESS")
        ?? promptAddress("Enter Jetton Minter address");
    val minter = JettonMinter { address: minterAddr };

    // ─── Resolve recipient ────────────────────────────────────────────────────

    val recipient = env<address>("MINT_RECIPIENT") ?? deployer.address;
    println("Recipient: {}", recipient);

    // ─── Resolve amount ───────────────────────────────────────────────────────
    // Default: 1,000,000 tUSDT = 1_000_000 * 10^6 = 1_000_000_000_000 nano-tokens

    val amount: coins = env<coins>("MINT_AMOUNT") ?? 1000000000000;
    println("Amount: {} (raw units, 6 decimals → {} tUSDT)", amount, amount / 1000000);
    println("");

    // ─── Send mint message ────────────────────────────────────────────────────

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

    val res = net.send(deployer.address, mintMsg);
    println(res.waitForTrace());
    println("");

    // ─── Print result ─────────────────────────────────────────────────────────

    val data = minter.getJettonData();
    val walletAddr = minter.getWalletAddress(recipient);
    val wallet = JettonWallet { address: walletAddr };

    println("═══════════════════════════════════════════════════");
    println("  Mint Complete");
    println("═══════════════════════════════════════════════════");
    println("  Minter:          {}", minter.address);
    println("  Total supply:    {} (raw)", data.totalSupply);
    println("  Recipient:       {}", recipient);
    println("  Recipient wallet: {}", walletAddr);

    if (scripts.isContractDeployed(walletAddr)) {
        val walletData = wallet.getWalletData();
        println("  Balance:         {} (raw) = {} tUSDT", walletData.jettonBalance, walletData.jettonBalance / 1000000);
    } else {
        println("  Balance:         <wallet not yet deployed>");
    }
}
