---
name: turbo-zora-uploader
description: >
  Use when creating Zora coins with @zoralabs/coins-sdk and the coin's metadata
  or media must be stored on Arweave or other permanent storage rather than
  IPFS. Covers which payment mode fits an externally owned account or a
  smart-contract wallet, the one call to make, the defaults that cost money or
  write permanent data, and which errors to catch. For Arweave uploads outside
  the Zora SDK, use @ardrive/turbo-upload instead.
---

# Store Zora coin metadata on Arweave

`@ardrive/turbo-zora-uploader` gives the Zora Coins SDK an `Uploader` that
stores files on Arweave through Turbo. Use it when a Zora coin's metadata or
image must be permanent. For any other Arweave upload, such as uploads with
other keys, prices, balances or top-ups, use `@ardrive/turbo-upload` instead.
The README is the full reference.

## Choose the mode from the wallet

The wallet that signs decides the signer shape and the mode:

| Wallet | Signer | Options | Who pays |
|---|---|---|---|
| An account with a private key (a viem `LocalAccount`) | `{ ...account, recoverPublicKey }` | Defaults. Add `maxUsdc` so files over the free tier can pay | Nobody for small files; USDC on Base above that |
| A browser wallet that is an externally owned account (a viem `WalletClient`) | The adapter in the README, under Quickstart | Defaults, plus `maxUsdc` | The same |
| A deployed smart-contract wallet, such as a Coinbase Smart Wallet | `{ address, signTypedData }` | `mode: "x402"` and `maxUsdc`, both required | The wallet, in USDC on Base, for every upload. It must be deployed first |

A smart-contract wallet can't sign data items. In the default `mode: "auto"`, a
signer with `signMessage` and `recoverPublicKey` takes the signed path for small
files, and a smart wallet's signature then fails with `TurboSignerError`, which
is not retried with x402. So pass `mode: "x402"` for one.

## Make the call

Create the uploader, as in the README quickstart:

```ts
// Production by default: uploads are permanent and public.
// Small files are free. maxUsdc is the most one larger upload may cost, in
// USDC base units (6 decimals): 500_000n is 0.50 USDC, paid on Base.
const uploader = createTurboUploader({
  signer: { ...account, recoverPublicKey },
  maxUsdc: 500_000n,
});
```

Pass `uploader` to `createMetadataBuilder()...upload(uploader)`, and spread
the `createMetadataParameters` it returns into the `call` of `createCoin`.

These constraints apply at that call:

- **Production is the default.** For anything not meant to last, pass
  `testnet: true`. On Base Sepolia, also set `skipMetadataValidation: true` in
  the `createCoin` call: Zora's metadata check refuses the testnet gateway's
  JSON content-type, which carries a charset. Don't set it on Base to get past
  a failure.
- **`maxUsdc` is USDC base units, 6 decimals, for each upload.** `500_000n` is
  0.50 USDC, not 500,000 dollars. A decimal such as `0.05` is refused. Without
  `maxUsdc`, the uploader has no USDC path.
- **`recoverPublicKey` is part of the signer.** Import it from `viem`. Without
  it, the signer can only pay with x402.
- **Keep `uri: "https"`, the default.** It returns
  `https://turbo-gateway.com/ITEM_ID`, which passes Zora's check right after
  upload. `uri: "ar"` returns `ar://ITEM_ID`, which Zora reads from
  arweave.net, so `createCoin` can fail for minutes or longer after upload.
- **The `Content-Type` tag comes from `file.type`.** Set the `File`'s type. A
  `Content-Type` in `tags` is refused.

## Catch these errors

The errors are `@ardrive/turbo-upload`'s classes, which this package doesn't
re-export, so check `err.name`:

| `err.name` | Catch it when | Then |
|---|---|---|
| `TurboConfigError` | `createTurboUploader` or `upload` got a bad option | Fix the option. Retrying doesn't help |
| `TurboPaymentError` | The address can't pay: the free quota is spent with no credits and the uploader has no x402 path, or the x402 price is over `maxUsdc` | Raise `maxUsdc` or fund the wallet. Retrying doesn't help |
| `TurboSignerError` | The wallet refused to sign, or a smart-contract wallet was asked to sign a data item | For a smart-contract wallet, use `mode: "x402"`. Nothing was uploaded |
| `TurboTimeoutError` | `timeout` passed, or `signal` aborted, during a request | Retry if the caller still wants the upload |
| `AbortError`, `TimeoutError` | The signal had already fired before a request started | Nothing was sent |

Anything else, such as `TurboHTTPError` or `TurboNetworkError`, is described in
[the turbo-upload errors reference](https://github.com/ardriveapp/turbo-upload#errors).

## Exports

The package exports one function, `createTurboUploader(options)`, and these
types: `TurboUploaderOptions`, `TurboUploader`, `TurboUploadResult`,
`TurboZoraSigner` and `ValidMetadataURI`.
