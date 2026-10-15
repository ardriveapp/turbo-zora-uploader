import { recoverPublicKey } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createTurboUploader } from "@ardrive/turbo-zora-uploader";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

// Testnet: nothing is permanent, and x402 pays in Base Sepolia USDC.
const uploader = createTurboUploader({
  signer: { ...account, recoverPublicKey },
  testnet: true,
  maxUsdc: 200_000n,
});
