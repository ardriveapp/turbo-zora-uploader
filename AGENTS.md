# AGENTS.md

For an agent wiring `@ardrive/turbo-zora-uploader` into a Zora Coins SDK
project. The README is the full reference, and [`SKILL.md`](SKILL.md) loads
this briefing as an Agent Skill.

## Does this apply

It is an `Uploader` for `@zoralabs/coins-sdk`: the object that
`createMetadataBuilder().upload(uploader)` takes. It stores a coin's image and
metadata on Arweave through Turbo. It does not
create, read or trade coins; the SDK does that.

**Use `@ardrive/turbo-upload` instead** for any Arweave upload that is not a
Zora `Uploader`, such as uploads with other keys, prices, balances or top-ups.

## The one call

This is the README quickstart, from the uploader on. The comments state the
defaults that cost money or write permanent data:

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

## Choose the mode from the wallet

The wallet that signs decides the signer shape and the mode:

| Wallet | Signer | Options | Who pays |
|---|---|---|---|
| An account with a private key (a viem `LocalAccount`) | `{ ...account, recoverPublicKey }` | The defaults, plus `maxUsdc` so files over the free tier can pay | Nobody for small files; USDC on Base above that |
| A browser wallet that is an externally owned account (a viem `WalletClient`) | The adapter in the README quickstart | The defaults, plus `maxUsdc` | The same |
| A deployed smart-contract wallet, such as a Coinbase Smart Wallet | `{ address, signTypedData }` | `mode: "x402"` and `maxUsdc`, both required | The wallet, in USDC on Base, for every upload |

## The things that get written wrong

- **Production is the default.** A bare `createTurboUploader({ signer })`
  writes permanent, public data. Pass `testnet: true` for anything not meant
  to last.
- **`maxUsdc` is USDC base units, 6 decimals, for each upload.** `500_000n` is
  0.50 USDC, not 500,000 dollars. A decimal such as `0.05` is refused. Without
  `maxUsdc` there is no USDC path, and with `mode: "signed"` it is refused.
- **`recoverPublicKey` is part of the signer.** Import it from `viem`. Without
  it, the signer can only pay with x402.
- **The metadata pointer is https, and media is `ar://`.** With the default
  `uri: "auto"`, a file of type `application/json` (the metadata JSON Zora's
  builder uploads) returns `https://turbo-gateway.com/ITEM_ID`, and every other
  file returns `ar://ITEM_ID`. Zora's create API refuses an `ar://` pointer, so
  `uri: "ar"` cannot create a coin. Leave `skipMetadataValidation` unset: the
  https pointer passes Zora's check.
- **A different gateway must serve a fresh item at once, as exactly
  `application/json`**, or Zora's metadata check fails. On 2026-10-14, the
  default testnet gateway, ar-io.dev, added a charset, which fails the check.
- **Testnet covers uploads, not coin creation.** On 2026-10-15, Zora's create
  API refused each Base Sepolia coin tried: the factory's `coinAddress` call
  reverted.
- **A smart-contract wallet needs `mode: "x402"`.** It cannot sign data items.
  In `mode: "auto"`, a signer with `signMessage` and `recoverPublicKey` takes
  the signed path for small files, and a smart wallet's signature then fails
  with `TurboSignerError`, which is not retried with x402.
- **The `Content-Type` tag comes from `file.type`.** Set the `File`'s type. A
  `Content-Type` in `tags` is refused, and so are tags over 3072 bytes when the
  uploader can pay with x402.
- **An x402 upload that fails after paying is not retried.** The payment might
  have settled. Check the payer's USDC transfers before uploading again.
- **`null` counts as absent** for every option.

## Errors

The errors are `@ardrive/turbo-upload`'s classes, which this package does not
re-export, so check `err.name`:

| `err.name` | Catch it when | Then |
|---|---|---|
| `TurboConfigError` | `createTurboUploader` or `upload` got a bad option | Fix the option. Retrying does not help |
| `TurboPaymentError` | The address cannot pay: the free quota is spent with no credits and the uploader has no x402 path, or the x402 price is over `maxUsdc`. It also covers a paid request that got a 402 because settling failed | Raise `maxUsdc` or fund the wallet; retrying does not help. If the message says the payment might have settled, check the payer's USDC transfers before you retry |
| `TurboSignerError` | The wallet refused to sign, or a smart-contract wallet was asked to sign a data item | For a smart-contract wallet, use `mode: "x402"`. Nothing was uploaded |
| `TurboTimeoutError`, `AbortError` or `TimeoutError` | The signal aborted or `timeout` passed | Retry if the caller still wants the upload. After an x402 payment was sent, check the payer's USDC transfers first |

Any other error, such as `TurboHTTPError` or `TurboNetworkError`, is described
in [the turbo-upload errors reference](https://github.com/ardriveapp/turbo-upload#errors).

## Exports

The package exports one function, `createTurboUploader(options)`, and these
types: `TurboUploaderOptions`, `TurboUploader`, `TurboUploadResult`,
`TurboZoraSigner` and `ValidMetadataURI`.
