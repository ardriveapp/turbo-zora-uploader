import { readFile } from "node:fs/promises";
import { createCoin, createMetadataBuilder } from "@zoralabs/coins-sdk";
import { createPublicClient, createWalletClient, http, recoverPublicKey } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createTurboUploader } from "@ardrive/turbo-zora-uploader";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

// Small files are free. maxUsdc is the most one larger upload may cost: 0.50 USDC, paid on Base.
const uploader = createTurboUploader({ signer: { ...account, recoverPublicKey }, maxUsdc: 500_000n });

const { createMetadataParameters } = await createMetadataBuilder()
  .withName("My Coin")
  .withSymbol("MYC")
  .withDescription("Metadata and image stored on Arweave")
  .withImage(new File([await readFile("coin.png")], "coin.png", { type: "image/png" }))
  .upload(uploader);

const { address, hash } = await createCoin({
  call: { ...createMetadataParameters, creator: account.address, currency: "ETH" },
  walletClient: createWalletClient({ account, chain: base, transport: http() }),
  publicClient: createPublicClient({ chain: base, transport: http() }),
});
console.log(createMetadataParameters.metadata.uri, address, hash);
