// Compiled, never run: `npm run types`. Fails if the uploader stops being the
// Zora Coins SDK's `Uploader`, or if a viem account stops being a signer.
import { createMetadataBuilder, type Uploader, type UploadResult } from "@zoralabs/coins-sdk";
import { recoverPublicKey, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createTurboUploader, type TurboUploader } from "@ardrive/turbo-zora-uploader";

const account = privateKeyToAccount(generatePrivateKey());

const both: Uploader = createTurboUploader({ signer: { ...account, recoverPublicKey }, maxUsdc: 50_000n });
const x402: Uploader = createTurboUploader({ signer: account, mode: "x402", maxUsdc: "50000", testnet: true });
const ar: Uploader = createTurboUploader({ signer: { ...account, recoverPublicKey }, uri: "ar", tags: [{ name: "App-Name", value: "x" }] });

// A browser wallet, wrapped as turbo-upload's README shows.
declare const walletClient: WalletClient;
const address = account.address;
const fromWallet: Uploader = createTurboUploader({
  signer: {
    address,
    signMessage: ({ message }) => walletClient.signMessage({ account: address, message }),
    recoverPublicKey,
    signTypedData: (t) => walletClient.signTypedData({ account: address, ...t }),
  },
  maxUsdc: 50_000n,
});

// The result is the SDK's UploadResult.
async function result(u: TurboUploader, file: File): Promise<UploadResult> {
  return u.upload(file, { signal: AbortSignal.timeout(1000), timeout: 500 });
}

// The SDK's metadata builder takes it.
createMetadataBuilder().withName("n").withSymbol("S").withDescription("d").upload(both);

// @ts-expect-error mode is a closed set
createTurboUploader({ signer: account, mode: "free" });
// @ts-expect-error uri is "https" or "ar"
createTurboUploader({ signer: account, uri: "ipfs", maxUsdc: 1 });
// @ts-expect-error a signer is required
createTurboUploader({ maxUsdc: 1 });

export { both, x402, ar, fromWallet, result };

// Combinations the runtime refuses are type errors too.
// @ts-expect-error mode "x402" needs maxUsdc
createTurboUploader({ signer: account, mode: "x402" });
// @ts-expect-error gateway has no effect with uri "ar"
createTurboUploader({ signer: account, maxUsdc: 1, uri: "ar", gateway: "https://example.com" });
// @ts-expect-error uri "https" needs a gateway
createTurboUploader({ signer: account, maxUsdc: 1, uri: "https" });
// @ts-expect-error maxUsdc has no effect with mode "signed"
createTurboUploader({ signer: { ...account, recoverPublicKey }, mode: "signed", maxUsdc: 1 });
const https: Uploader = createTurboUploader({ signer: account, maxUsdc: 1, uri: "https", gateway: "https://example.com" });
const nulls: Uploader = createTurboUploader({ signer: account, maxUsdc: 1, gateway: null });
export { https, nulls };
