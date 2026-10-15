# @ardrive/turbo-zora-uploader

An `Uploader` for the [Zora Coins SDK](https://www.npmjs.com/package/@zoralabs/coins-sdk)
that stores a coin's metadata and media on Arweave through Turbo. Pass it
anywhere the SDK takes an uploader, such as `createMetadataBuilder().upload()`.
Small files signed by an EVM account are free.

It has one runtime dependency,
[`@ardrive/turbo-upload`](https://github.com/ardriveapp/turbo-upload), which
has none. If you are an agent writing an integration, read
[`AGENTS.md`](AGENTS.md) first.

```bash
npm install @ardrive/turbo-zora-uploader
```

You bring `viem` and `@zoralabs/coins-sdk`, which a Zora project already has.

## Quickstart

```ts
import { readFile } from "node:fs/promises";
import { createCoin, createMetadataBuilder } from "@zoralabs/coins-sdk";
import {
  createPublicClient,
  createWalletClient,
  http,
  recoverPublicKey,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createTurboUploader } from "@ardrive/turbo-zora-uploader";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

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

In the comments here and in the sections that follow, ITEM_ID stands for the
Arweave item ID that an upload returns.

Runnable versions, which default to testnet, are in [`examples/`](examples/):
`node-eoa.mjs` for an account with a private key, and `smart-wallet-x402.mjs`
for a smart-contract wallet.

In a browser, wrap the wallet client:

```ts
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
```

A browser wallet does not expose its public key, so the first signed upload asks
the user to sign one extra connect message, and the key is recovered from it.
To skip that prompt, add `publicKey` to the signer: the 65-byte uncompressed
key, as hex.

## Who pays

The uploader has two payment paths:

| | Signed | x402 |
|---|---|---|
| The signer needs | `signMessage` and `recoverPublicKey` (from viem) | `signTypedData`, and you set `maxUsdc` |
| Who pays | Nobody, for items up to 105 KiB, until the address (or the IP address uploading) has stored 10 MiB. After that, Turbo credits on the address | The signer, in USDC on Base, for every item. There is no free tier |
| Who owns the item | The signer: it signed the data item (ANS-104 type 3) | The upload service, which signs the item; the signer is recorded as the payer |
| Wallets | An externally owned account. A smart-contract wallet cannot sign data items | Any, including a deployed smart-contract wallet (ERC-1271) |
| Largest file | Set by the upload service. Items over 10 MiB go up in chunks | About 75 MiB per upload |

`maxUsdc` is the most one upload may cost, in USDC base units (6 decimals):
`500_000n` is 0.50 USDC. When the service asks for more, the upload fails with
`TurboPaymentError` before the payment is signed. For scale, the service's price
estimate (`getUnsignedX402Price` in `@ardrive/turbo-upload`) for a 3 MB image
was 0.24 USDC on 2026-10-14, and the amount it asks at upload can be higher.
`maxUsdc` is a positive whole number, as a bigint, a number or a digit string,
so `0.05` is refused.

The free tier sizes are the upload service's policy, and they change. In auto
mode, the uploader reads the item limit from the service on the first upload
that needs it. If that read fails, the upload fails with its error, and the
next upload reads it again.

`mode: "auto"`, the default, picks the path for each file in this order:

1. x402, when the signer has no `signMessage` or no `recoverPublicKey`. This is
   decided before anything is signed.
2. Signed, when the item fits the free tier, or when the signer cannot pay (no
   `signTypedData`, or no `maxUsdc`).
3. x402, for anything larger.
4. If the service refuses a signed item with `TurboPaymentError` (the free
   quota is spent and the address has too few credits), nothing is stored. The
   same file then goes to x402, and so does every later upload from that
   uploader.

Any other failure is thrown. That includes a `TurboSignerError`, from a wallet
that refuses the prompt or from a smart-contract wallet, whose signature cannot
sign a data item. **For a smart-contract wallet, pass `mode: "x402"`.**

A failure on the signed path pays nothing. An x402 upload that fails after its
payment is sent is not retried, and the payment might have settled: check the
payer's USDC transfers before you upload the file again. The error from
`@ardrive/turbo-upload` says so, including a `TurboPaymentError` for a 402 that
the service answers when settling fails.

This keeps a Zora creator's usual upload, one image and one metadata file, free
with no setup. A larger file goes through x402 without code changes, as long as
its price is within `maxUsdc`. To pay only with Turbo credits, set
`mode: "signed"`. To pay for every upload with USDC, set `mode: "x402"`.

## The URLs it returns

By default (`uri: "auto"`), the uploader returns one of two URL forms:

- **The metadata JSON:** `https://turbo-gateway.com/ITEM_ID`. This is the
  coin's metadata pointer. Zora's create API takes only an `https://` or
  `ipfs://` pointer, and refuses `ar://`.
- **Everything else, such as the image or other media:** `ar://ITEM_ID`,
  which names no gateway, so a client can read it through a gateway it
  chooses that has the item.

The uploader tells the two apart by `file.type`: `application/json` is the
metadata. Zora's `createMetadataBuilder` uploads the metadata as a `File` of
that type, and writes the URL it gets for the image into the metadata's
`image` field. How Zora's apps display `ar://` media is not verified here.

Before it creates a coin, Zora's SDK fetches the metadata pointer and checks
it. The check passes only if the gateway serves a freshly uploaded item at
once, with a content-type of exactly `application/json`. turbo-gateway.com did
both on 2026-10-14: `scripts/live-mainnet-free.js` saw the check pass 1.2 s
after a free upload. To use another gateway, pass `gateway`.

Two other forms are available:

- **`uri: "https"`** returns the gateway URL for every file.
- **`uri: "ar"`** returns `ar://ITEM_ID` for every file, including the
  metadata. It cannot create a Zora coin, because Zora's create API refuses an
  `ar://` pointer.

A gateway with credentials, a space, a query or a fragment is refused, and so
is `gateway` together with `uri: "ar"`.

## Testnet

To try it without writing permanent data, pass `testnet: true`:

```ts
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
```

On testnet, signed items are free up to a larger size, x402 pays in Base
Sepolia USDC, and nothing is permanent. Testnet items are served by
`https://ar-io.dev`, the default gateway there. arweave.net does not serve
them, because they are not on Arweave.

Testnet covers uploads, not coin creation:

- On 2026-10-15, Zora's create API refused each Base Sepolia coin tried: the
  coin factory's `coinAddress` call reverted, with a passing https pointer and
  with currency ETH, ZORA or CREATOR_COIN.
- On 2026-10-14, ar-io.dev served JSON as `application/json; charset=utf-8`,
  which Zora's metadata check refuses.

## Options

`createTurboUploader` takes the following options:

| Option | Default | Notes |
|---|---|---|
| `signer` | Required | An EVM signer for one or both paths |
| `mode` | `"auto"` | `"auto"`, `"signed"` or `"x402"` |
| `maxUsdc` | None | USDC base units, for each upload. Required for x402, refused with `mode: "signed"` |
| `uri` | `"auto"` | `"auto"`: the metadata JSON on the gateway, media as `ar://ITEM_ID`. `"https"`: everything on the gateway. `"ar"`: everything as `ar://ITEM_ID`, which cannot create a Zora coin |
| `gateway` | `https://turbo-gateway.com`, or `https://ar-io.dev` on testnet | https, with no credentials, spaces, query or fragment. Refused with `uri: "ar"` |
| `testnet` | `false` | Production when `false`: permanent and public |
| `tags` | `[]` | `{ name, value }` strings, added to every item. The `Content-Type` tag comes from `file.type`, and a `Content-Type` here is refused. When the uploader can pay with x402, at most 3072 bytes, the most x402 carries |
| `fetch` | The global `fetch` | A function, for tests and proxies |

An unknown or invalid option throws `TurboConfigError` when the uploader is
created. `null` counts as absent for every option.

`upload(file, { signal, timeout })` honours both: `timeout` is a deadline for
the whole upload in milliseconds, and 0 means none, as in the SDK's own
uploader. A `timeout` that is negative, over 4294967295 or not a number throws
`TurboConfigError`. When `signal` aborts or `timeout` passes, the upload throws
`TurboTimeoutError`, `AbortError` or `TimeoutError`, depending on when.

In a browser without `AbortSignal.any`, such as Safari before 17.4, the
uploader combines `signal` and `timeout` itself.

Other errors come from `@ardrive/turbo-upload`. For more information, see
[the turbo-upload errors reference](https://github.com/ardriveapp/turbo-upload#errors).

## License

Apache-2.0
