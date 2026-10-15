import { recoverPublicKey, type WalletClient } from "viem";
import { createTurboUploader } from "@ardrive/turbo-zora-uploader";

type Address = `0x${string}`;

export function uploaderFor(walletClient: WalletClient, address: Address) {
  return createTurboUploader({
    signer: {
      address,
      signMessage: ({ message }) =>
        walletClient.signMessage({ account: address, message }),
      recoverPublicKey,
      signTypedData: (typedData) =>
        walletClient.signTypedData({ account: address, ...typedData }),
    },
    maxUsdc: 500_000n,
  });
}
