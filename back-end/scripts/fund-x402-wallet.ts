/**
 * Fund the x402 receiving wallet with testnet ETH for gas
 * 
 * Run with: npx tsx scripts/fund-x402-wallet.ts
 * 
 * Note: This uses Base Sepolia testnet faucet
 */

import { CdpClient } from "@coinbase/cdp-sdk";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("💰 Funding x402 wallet with testnet ETH...\n");

  const walletAddress = process.env.X402_RECEIVING_WALLET;
  
  if (!walletAddress) {
    console.error("❌ X402_RECEIVING_WALLET not set in .env");
    process.exit(1);
  }

  console.log(`📬 Wallet: ${walletAddress}\n`);

  try {
    const cdp = new CdpClient();

    console.log("📝 Requesting ETH from Base Sepolia faucet...");
    const faucetResponse = await cdp.evm.requestFaucet({
      address: walletAddress,
      network: "base-sepolia",
      token: "eth"
    });

    console.log("\n✅ Faucet request successful!");
    console.log(`🔗 Transaction: https://sepolia.basescan.org/tx/${faucetResponse.transactionHash}`);
    
    // Also request USDC for testing payments
    console.log("\n📝 Requesting USDC from Base Sepolia faucet...");
    try {
      const usdcResponse = await cdp.evm.requestFaucet({
        address: walletAddress,
        network: "base-sepolia",
        token: "usdc"
      });
      console.log(`✅ USDC Transaction: https://sepolia.basescan.org/tx/${usdcResponse.transactionHash}`);
    } catch (usdcError) {
      console.log("⚠️  USDC faucet not available or rate limited");
    }

    console.log("\n✅ Wallet funded! Ready for testing.");
    console.log("📊 View balance: https://sepolia.basescan.org/address/" + walletAddress);

  } catch (error) {
    console.error("❌ Failed to fund wallet:", error);
    process.exit(1);
  }
}

main();

