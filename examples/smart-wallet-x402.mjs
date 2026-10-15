// Stores coin metadata from a smart-contract wallet, which cannot sign data
// items and pays with x402 instead: USDC, on Base Sepolia here. It pays only
// with --pay.
//
//   OWNER_KEY=0x... node examples/smart-wallet-x402.mjs [--pay]
//
// The smart account must be deployed (any first transaction deploys it) and
// hold Base Sepolia USDC. Without --pay, this prints the plan and stops.
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { createTurboUploader } from "@ardrive/turbo-zora-uploader";

if (!process.env.OWNER_KEY) {
  console.error("Set OWNER_KEY to the smart account owner's private key.");
  process.exit(2);
}
const wallet = await toCoinbaseSmartAccount({
  client: createPublicClient({ chain: baseSepolia, transport: http() }),
  owners: [privateKeyToAccount(process.env.OWNER_KEY)],
  version: "1.1",
});

// The most one upload may cost, in USDC base units (6 decimals): 0.20 USDC.
const maxUsdc = 200_000n;
const uploader = createTurboUploader({
  signer: {
    address: wallet.address,
    signTypedData: (typedData) => wallet.signTypedData(typedData),
  },
  mode: "x402",
  maxUsdc,
  testnet: true,
});

const body = { name: "Example", description: "x402", image: "ar://EXAMPLE" };
const metadata = new File([JSON.stringify(body)], "metadata.json", {
  type: "application/json",
});

if (!process.argv.includes("--pay")) {
  console.log(`Would pay up to ${maxUsdc} base units from ${wallet.address}.`);
  console.log("Not paid. Pass --pay to upload.");
  process.exit(0);
}
const { url } = await uploader.upload(metadata, { timeout: 180_000 });
console.log("metadata", url);
