// Stores coin metadata from a smart-contract wallet, which cannot sign data
// items and pays with x402 instead: USDC, on Base Sepolia here. It pays only
// with --pay.
//
//   OWNER_KEY=HEX_KEY node examples/smart-wallet-x402.mjs [--pay]
//
// Replace HEX_KEY with the smart account owner's 0x-prefixed hex private key.
// With --pay, the smart account must be deployed (any first transaction
// deploys it) and hold Base Sepolia USDC. Without --pay, this prints the plan
// and stops before any network request.
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCoinbaseSmartAccount } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import { createTurboUploader } from "@ardrive/turbo-zora-uploader";

if (!process.env.OWNER_KEY) {
  console.error("Set OWNER_KEY to the smart account owner's private key.");
  process.exit(2);
}
const owner = privateKeyToAccount(process.env.OWNER_KEY);

// The most one upload may cost, in USDC base units (6 decimals): 0.20 USDC.
const maxUsdc = 200_000n;

if (!process.argv.includes("--pay")) {
  console.log(`Would pay up to ${maxUsdc} base units in USDC, from the`);
  console.log(`Coinbase smart account owned by ${owner.address}.`);
  console.log("Not paid. Pass --pay to upload.");
  process.exit(0);
}

const wallet = await toCoinbaseSmartAccount({
  client: createPublicClient({ chain: baseSepolia, transport: http() }),
  owners: [owner],
  version: "1.1",
});
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
// Returns ar://ITEM_ID, the default.
const { url } = await uploader.upload(metadata, { timeout: 180_000 });
console.log("metadata", url);
