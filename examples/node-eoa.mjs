// Stores a coin's image and metadata through the free signed path, then builds
// the call that createCoin takes. It sends a transaction only with --send.
//
//   PRIVATE_KEY=0x... node examples/node-eoa.mjs [--production] [--send]
//
// Testnet unless you pass --production. Production uploads are permanent and
// public. Small files are free on both, so this example pays nothing for
// storage; --send pays gas on Base Sepolia, or on Base with --production.
import { createCoin, createMetadataBuilder } from "@zoralabs/coins-sdk";
import {
  createPublicClient,
  createWalletClient,
  http,
  recoverPublicKey,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { createTurboUploader } from "@ardrive/turbo-zora-uploader";

const production = process.argv.includes("--production");
const send = process.argv.includes("--send");
if (!process.env.PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY to a 0x-prefixed hex private key.");
  process.exit(2);
}
const account = privateKeyToAccount(process.env.PRIVATE_KEY);

// No maxUsdc, so this uploader has no USDC path: every file is signed by the
// account, which owns the stored items.
const uploader = createTurboUploader({
  signer: { ...account, recoverPublicKey },
  testnet: !production,
});

// A 1x1 PNG, so the example needs no file on disk.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhg" +
      "GAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const { createMetadataParameters, metadata } = await createMetadataBuilder()
  .withName("Example Coin")
  .withSymbol("EXMPL")
  .withDescription("Metadata and image stored on Arweave through Turbo")
  .withImage(new File([png], "coin.png", { type: "image/png" }))
  .upload(uploader);

console.log("image   ", metadata.image);
console.log("metadata", createMetadataParameters.metadata.uri);

const chain = production ? base : baseSepolia;
const call = {
  ...createMetadataParameters,
  creator: account.address,
  currency: "ETH",
  chainId: chain.id,
  // Zora's metadata check refuses the testnet gateway's content-type (it adds
  // a charset), so testnet skips it. Don't skip it on Base.
  skipMetadataValidation: !production,
};
console.log("createCoin call", call);

if (!send) {
  console.log("Not sent. Pass --send to create the coin.");
  process.exit(0);
}
const { address, hash } = await createCoin({
  call,
  walletClient: createWalletClient({ account, chain, transport: http() }),
  publicClient: createPublicClient({ chain, transport: http() }),
});
console.log("coin", address, "tx", hash);
