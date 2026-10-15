---
name: turbo-zora-uploader
description: >
  Use when creating Zora coins with @zoralabs/coins-sdk and the coin's metadata
  or media must be stored on Arweave or other permanent storage rather than
  IPFS. Gives the one call to make; the package's AGENTS.md has the
  constraints, the mode for each kind of wallet, and the errors to catch. For
  Arweave uploads outside the Zora SDK, use @ardrive/turbo-upload instead.
---

# Store Zora coin metadata on Arweave

`@ardrive/turbo-zora-uploader` gives the Zora Coins SDK an `Uploader` that
stores a coin's image and metadata on Arweave through Turbo. Use it when a
Zora coin's metadata or media must be permanent.

Make this call, which is the README quickstart from the uploader on:

```ts
// Production by default: uploads are permanent and public. Small files are
// free. maxUsdc is the most one larger upload may cost, in USDC base units
// (6 decimals): 500_000n is 0.50 USDC, on Base.
const uploader = createTurboUploader({
  signer: { ...account, recoverPublicKey },
  maxUsdc: 500_000n,
});

const png = await readFile("coin.png");
const { createMetadataParameters } = await createMetadataBuilder()
  .withName("My Coin")
  .withSymbol("MYC")
  .withDescription("Metadata and image stored on Arweave")
  .withImage(new File([png], "coin.png", { type: "image/png" }))
  .upload(uploader);
// The metadata pointer is https://turbo-gateway.com/ITEM_ID, because Zora's
// create API takes only https or ipfs. The image inside it is ar://ITEM_ID,
// which names no gateway.

const { address, hash } = await createCoin({
  call: {
    ...createMetadataParameters,
    creator: account.address,
    currency: "ETH",
  },
  walletClient: createWalletClient({ account, chain: base, transport: http() }),
  publicClient: createPublicClient({ chain: base, transport: http() }),
});
console.log(createMetadataParameters.metadata.uri, address, hash);
```

Before you change any option, or handle errors, read
[`AGENTS.md`](AGENTS.md) in this package. It has the constraints, the mode for
each kind of wallet, the errors as "catch it when", and the exports.
