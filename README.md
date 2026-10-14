# @ardrive/turbo-zora-uploader

An `Uploader` for the [Zora Coins SDK](https://www.npmjs.com/package/@zoralabs/coins-sdk)
that stores a coin's metadata and media on Arweave through Turbo. Pass it
anywhere the SDK takes an uploader, such as `createMetadataBuilder().upload()`.
Small files from an EVM account are free.

One runtime dependency, [`@ardrive/turbo-upload`](https://github.com/ardriveapp/turbo-upload),
which has none. Agents writing an integration: read [`AGENTS.md`](AGENTS.md).

```bash
npm install @ardrive/turbo-zora-uploader
```

You bring `viem` and `@zoralabs/coins-sdk`, which a Zora project already has.

## Quickstart

```ts
import { readFile } from "node:fs/promises";
import { createCoin, createMetadataBuilder } from "@zoralabs/coins-sdk";
import { createPublicClient, createWalletClient, http, recoverPublicKey } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createTurboUploader } from "@ardrive/turbo-zora-uploader";

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

// Free for small files; files over the free tier pay up to 0.05 USDC each on Base.
const uploader = createTurboUploader({ signer: { ...account, recoverPublicKey }, maxUsdc: 50_000n });

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
```

In a browser, wrap the wallet client:

```ts
const signer = {
  address,
  signMessage: ({ message }) => walletClient.signMessage({ account: address, message }),
  recoverPublicKey,
  signTypedData: (typedData) => walletClient.signTypedData({ account: address, ...typedData }),
};
```

## Who pays

| | signed | x402 |
|---|---|---|
| The signer needs | `signMessage` and `recoverPublicKey` (from viem) | `signTypedData`, and you set `maxUsdc` |
| Who pays | Nobody, for items up to 105 KiB, until the address (or the IP address uploading) has stored 10 MiB. After that, Turbo credits on the address | The signer, in USDC on Base, for every item. There is no free tier |
| Who owns the item | The signer: it signed the data item (ANS-104 type 3) | The upload service, which signs the item; the signer is recorded as the payer |
| Wallets | An externally owned account. A smart-contract wallet cannot sign data items | Any, including a deployed smart-contract wallet (ERC-1271) |

`maxUsdc` is the most one upload may pay, in USDC base units: `50_000n` is
0.05 USDC. Over it, the upload is refused before anything is signed. The free
tier sizes are the upload service's policy, and change; the uploader reads the
current item limit from the service once.

**`mode: "auto"`** (the default) picks the path per file:

1. Signed, when the signer can sign data items and the item fits the free tier.
2. x402 otherwise, when the signer has `signTypedData` and `maxUsdc` is set.
3. If a signed upload fails because the address cannot pay, or because the
   wallet returns a signature that cannot sign a data item, it goes to x402,
   and so does every later upload from that uploader. A wallet that refuses the
   prompt is not asked to pay instead.

A signer with only one path uses that path for every file. This keeps a Zora
creator's usual upload, one image and one metadata file, free with no setup,
and makes a larger file or a smart wallet work without code changes. Set
`mode: "signed"` to never pay with USDC (to spend Turbo credits instead), or
`mode: "x402"` to always pay.

## The URL it returns

The default is `https://turbo-gateway.com/<id>`. Pass `uri: "ar"` for
`ar://<id>`, or `gateway` for another https gateway.

Zora checks the metadata URI before it creates a coin: it fetches the URI and
requires the content-type to be exactly `application/json` or `text/plain`.
It reads `ar://` URIs from `http://arweave.net/`, which has taken 6 to 30
minutes to serve a new item, and sometimes never did, and `createCoin` fails
until it does. turbo-gateway.com serves a new item at once, as
`application/json`: in a test, the check passed 1.2 s after a free upload.

## Testnet

```ts
const uploader = createTurboUploader({ signer: { ...account, recoverPublicKey }, testnet: true, maxUsdc: 200_000n });
```

`testnet: true` uploads to the testnet service, where signed items are free up
to a larger size and x402 pays in Base Sepolia USDC. Testnet items are served
by `https://ar-io.dev`, not turbo-gateway.com, so that is the default gateway
there, and nothing on testnet is permanent.

**Zora's metadata check fails on testnet.** ar-io.dev serves JSON as
`application/json; charset=utf-8` (checked 2026-10-14), which the check
refuses. On Base Sepolia, pass `skipMetadataValidation: true` to
`createCoinCall`, or upload the metadata with a production uploader.

## Options

| option | default | |
|---|---|---|
| `signer` | required | an EVM signer for one or both paths |
| `mode` | `"auto"` | `"auto"`, `"signed"` or `"x402"` |
| `maxUsdc` | | USDC base units, per upload. Required for x402 |
| `uri` | `"https"` | `"https"` or `"ar"` |
| `gateway` | `https://turbo-gateway.com`, testnet `https://ar-io.dev` | |
| `testnet` | `false` | |
| `tags` | `[]` | added to every item. The `Content-Type` tag comes from `file.type` |
| `fetch` | global `fetch` | for tests and proxies |

An unknown or invalid option throws `TurboConfigError` when the uploader is
created. `upload(file, { signal, timeout })` honours both: `timeout` is a
deadline for the whole upload, in milliseconds. The errors it throws are
`@ardrive/turbo-upload`'s, described in
[its README](https://github.com/ardriveapp/turbo-upload#errors).

## License

Apache-2.0
