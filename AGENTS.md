# AGENTS.md

For an agent wiring `@ardrive/turbo-zora-uploader` into a Zora Coins SDK
project. The README is the full reference.

## Does this apply

It is an `Uploader` for `@zoralabs/coins-sdk`: the object the SDK's
`createMetadataBuilder().upload(uploader)` takes. It stores files on Arweave
through Turbo and returns `https://turbo-gateway.com/<id>`. It does not create
coins, read them or trade them; the SDK does that.

**Use `@ardrive/turbo-upload` directly** for anything that is not a Zora
`Uploader`: uploads with other keys, prices, balances, top-ups.

## Setup

```js
import { recoverPublicKey } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createTurboUploader } from "@ardrive/turbo-zora-uploader";

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const uploader = createTurboUploader({ signer: { ...account, recoverPublicKey }, maxUsdc: 500_000n });
```

`testnet: true` for anything not meant to last. Production uploads are
permanent and public.

## The things that get written wrong

**1. `recoverPublicKey` is part of the signer.** A bare viem account has no
`recoverPublicKey`, so it cannot sign data items and can only pay with x402.
Without `maxUsdc` as well, `createTurboUploader` throws.

**2. `maxUsdc` is in USDC base units**, six decimals: `500_000n` is 0.50 USDC,
not 500 000 dollars. It caps each upload, not the total. A decimal such as
`0.05` is refused at creation.

**3. Production is the default.** A bare `createTurboUploader({ signer })`
writes permanent data.

**4. On testnet, Zora's metadata check fails.** The testnet gateway serves
JSON with a charset, and the check wants exactly `application/json`. Pass
`skipMetadataValidation: true` to `createCoinCall` on Base Sepolia. Never set it
on Base to get past a failure: there it means the metadata URI is wrong.

**5. A smart-contract wallet needs `mode: "x402"` and `maxUsdc`.** It cannot
sign data items. In `"auto"`, a signer that has both `signMessage` and
`recoverPublicKey` is tried on the signed path first. A smart wallet's
signature then fails with `TurboSignerError`, which is thrown and not retried
with x402.

## Errors

The uploader throws `@ardrive/turbo-upload`'s errors. Check `err.name`:

| name | means |
|---|---|
| `TurboConfigError` | a bad option, at `createTurboUploader` |
| `TurboPaymentError` | the address cannot pay: out of free quota with no credits, or the x402 price is over `maxUsdc`. Retrying never helps |
| `TurboSignerError` | the wallet refused or cannot sign. Nothing was uploaded. For a smart-contract wallet, use `mode: "x402"` |
| `TurboTimeoutError` | `timeout` passed, or `signal` aborted, during a request |
| `AbortError`, `TimeoutError` | the signal's own reason, when it had already fired before a request started |
