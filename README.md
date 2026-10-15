# @ardrive/turbo-zora-uploader

An `Uploader` for the [Zora Coins SDK](https://www.npmjs.com/package/@zoralabs/coins-sdk)
that stores a coin's metadata and media on Arweave through Turbo. Pass it
anywhere the SDK takes an uploader, such as `createMetadataBuilder().upload()`.
Small files signed by an EVM account are free.

It has one runtime dependency,
[`@ardrive/turbo-upload`](https://github.com/ardriveapp/turbo-upload), which
has none. If you are an agent writing an integration, load
[`SKILL.md`](SKILL.md) first.

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

// Production by default: uploads are permanent and public.
// Small files are free. maxUsdc is the most one larger upload may cost, in
// USDC base units (6 decimals): 500_000n is 0.50 USDC, paid on Base.
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

A browser wallet doesn't expose its public key, so the first signed upload asks
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
| Wallets | An externally owned account. A smart-contract wallet can't sign data items | Any, including a deployed smart-contract wallet (ERC-1271) |
| Largest file | Set by the upload service. Items over 10 MiB go up in chunks | About 75 MiB per upload |

`maxUsdc` is the most one upload may cost, in USDC base units (6 decimals):
`500_000n` is 0.50 USDC. When the service asks for more, the upload fails with
`TurboPaymentError` before anything is signed. For scale, the service's price
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
2. Signed, when the item fits the free tier, or when the signer can't pay (no
   `signTypedData`, or no `maxUsdc`).
3. x402, for anything larger.
4. If the service refuses a signed item with `TurboPaymentError` (the free
   quota is spent and the address has too few credits), nothing is stored. The
   same file then goes to x402, and so does every later upload from that
   uploader.

Any other failure is thrown, and nothing is paid. That includes a
`TurboSignerError`, from a wallet that refuses the prompt or from a
smart-contract wallet, whose signature can't sign a data item. **For a
smart-contract wallet, pass `mode: "x402"`.**

This keeps a Zora creator's usual upload, one image and one metadata file, free
with no setup. A larger file goes through x402 without code changes, as long as
its price is within `maxUsdc`. To pay only with Turbo credits, set
`mode: "signed"`. To pay for every upload with USDC, set `mode: "x402"`.

## The URL it returns

The default is `https://turbo-gateway.com/ITEM_ID`. Pass `uri: "ar"` for
`ar://ITEM_ID`, or `gateway` for another https gateway. A gateway with a query
or a fragment is refused, and so is `gateway` together with `uri: "ar"`.

Zora checks the metadata URI before it creates a coin: it fetches the URI and
requires the content-type to be exactly `application/json` or `text/plain`.
It reads `ar://` URIs from `http://arweave.net/`, which can take minutes or
longer to serve a freshly uploaded item, and `createCoin` fails until it does.
turbo-gateway.com serves a freshly uploaded item as `application/json`: on
2026-10-14, `scripts/live-mainnet-free.js` saw the check pass 1.2 s after a
free upload.

## Testnet

To try it without writing permanent data, pass `testnet: true`:

```ts
const uploader = createTurboUploader({
  signer: { ...account, recoverPublicKey },
  testnet: true,
  maxUsdc: 200_000n,
});
```

On testnet, signed items are free up to a larger size, and x402 pays in Base
Sepolia USDC. Testnet items are served by `https://ar-io.dev`, not
turbo-gateway.com, so that is the default gateway there. Nothing on testnet is
permanent.

**Zora's metadata check fails on testnet.** On 2026-10-14, ar-io.dev served
JSON as `application/json; charset=utf-8`, which the check refuses. On Base
Sepolia, set `skipMetadataValidation: true` in the `createCoin` call, or upload
the metadata with a production uploader.

## Options

`createTurboUploader` takes the following options:

| Option | Default | Notes |
|---|---|---|
| `signer` | Required | An EVM signer for one or both paths |
| `mode` | `"auto"` | `"auto"`, `"signed"` or `"x402"` |
| `maxUsdc` | None | USDC base units, for each upload. Required for x402 |
| `uri` | `"https"` | `"https"` or `"ar"` |
| `gateway` | `https://turbo-gateway.com`, or `https://ar-io.dev` on testnet | https, with no query or fragment. Not with `uri: "ar"` |
| `testnet` | `false` | Production when `false`: permanent and public |
| `tags` | `[]` | `{ name, value }` strings, added to every item. The `Content-Type` tag comes from `file.type`, and a `Content-Type` here is refused |
| `fetch` | The global `fetch` | A function, for tests and proxies |

An unknown or invalid option throws `TurboConfigError` when the uploader is
created. `upload(file, { signal, timeout })` honours both: `timeout` is a
deadline for the whole upload in milliseconds, and 0 means none, as in the
SDK's own uploader. A negative `timeout` throws `TurboConfigError`. Other
errors come from `@ardrive/turbo-upload`. For more information, see
[the turbo-upload errors reference](https://github.com/ardriveapp/turbo-upload#errors).

## Release a version

To release, push a `vVERSION` tag on main, where VERSION is the version in
`package.json`. [The publish workflow](.github/workflows/publish.yml) publishes
it with npm provenance. The first version, 0.1.0, is published by hand,
because npm attaches a trusted publisher only to a package that exists. The
steps are in the comment at the top of the workflow.

## License

Apache-2.0
