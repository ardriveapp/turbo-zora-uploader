"use strict";
/**
 * The uploader against the testnet upload service and Base Sepolia. Testnet
 * money only. Not part of the package.
 *
 *   node scripts/live-testnet.js                  # signed uploads, free, fresh key
 *   PAYER_KEY_FILE=~/sepolia.key node scripts/live-testnet.js
 *                                                 # also x402 and the Zora flow, with a funded key
 *   node scripts/live-testnet.js --check-guards   # offline: the refusals only
 *
 *   PAYER_KEY_FILE  one raw 0x-hex secp256k1 key, mode 600. Read, never printed.
 *                   Pays x402 in Base Sepolia USDC and coin creation gas in
 *                   Base Sepolia ETH. With a zero balance, those steps are
 *                   skipped and say so.
 *
 * Spend caps: 1 USDC and 0.02 ETH per run. Every request goes through a fetch
 * that refuses any host not on the list below, and the x402 signer refuses
 * typed data for any chain but Base Sepolia (84532).
 */

const fs = require("node:fs");
const { createPublicClient, createWalletClient, http, erc20Abi, formatEther, formatUnits, recoverPublicKey } = require("viem");
const { baseSepolia } = require("viem/chains");
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");

/* ------------------------------ guards ------------------------------- */

const ALLOWED_HOSTS = new Set([
  "upload.services.ar-io.dev",
  "payment.services.ar-io.dev",
  "ar-io.dev",
  "sepolia.base.org",
  "api-sdk.zora.engineering", // coin calldata; the chain is chosen by chainId, checked below
]);
const CHAIN_ID = 84532;
const USDC_CAP = 1_000_000n; // 1 USDC
const ETH_CAP = 20_000_000_000_000_000n; // 0.02 ETH
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC = "https://sepolia.base.org";

function assertAllowed(url) {
  const host = new URL(url).hostname;
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`REFUSING: ${url} is not on the testnet host list.`);
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  assertAllowed(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  return realFetch(input, init);
};

/** The signer, refusing typed data for any chain but Base Sepolia. */
const sepoliaOnly = (signer) => ({
  ...signer,
  signTypedData: async (typedData) => {
    if (typedData.domain.chainId !== CHAIN_ID) throw new Error(`REFUSING: typed data for chain ${typedData.domain.chainId}, not ${CHAIN_ID}.`);
    return signer.signTypedData(typedData);
  },
});

// Loaded after fetch is wrapped, so the SDK's API client sees the guarded one.
const { createTurboUploader } = require("..");
const { createMetadataBuilder, createCoinCall, createCoin, validateMetadataURIContent } = require("@zoralabs/coins-sdk");

if (process.argv.includes("--check-guards")) {
  const refused = [];
  for (const url of ["https://upload.ardrive.io/v1/tx", "https://turbo-gateway.com/x", "https://arweave.net/x", "https://mainnet.base.org", "https://example.com"]) {
    try {
      assertAllowed(url);
    } catch {
      refused.push(url);
    }
  }
  sepoliaOnly({ signTypedData: async () => "0x" })
    .signTypedData({ domain: { chainId: 8453 } })
    .then(() => false, () => true)
    .then((chainRefused) => {
      console.log(`guards: refused ${refused.length}/5 hosts off the list, chain 8453 ${chainRefused ? "refused" : "NOT refused"}`);
      process.exit(refused.length === 5 && chainRefused ? 0 : 1);
    });
  return;
}

/* ------------------------------ helpers ------------------------------ */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const line = (k, v) => console.log(`    ${k.padEnd(26)} ${v}`);
const failures = [];
const skipped = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Read a URL until it answers 200, for up to two minutes. */
async function readBack(url, expected) {
  for (let i = 0; i < 24; i++) {
    const res = await fetch(url);
    if (res.ok) {
      const body = Buffer.from(await res.arrayBuffer());
      return { same: body.equals(Buffer.from(expected)), contentType: res.headers.get("content-type") };
    }
    await res.arrayBuffer().catch(() => {});
    await sleep(5000);
  }
  return { same: false, contentType: "never answered 200" };
}

async function zoraCheck(url) {
  try {
    await validateMetadataURIContent(url);
    return "VALID";
  } catch (err) {
    return `refused: ${err.message}`;
  }
}

function readKey(path) {
  if ((fs.statSync(path).mode & 0o077) !== 0) throw new Error(`${path} is readable by other users. chmod 600 it first.`);
  const key = fs.readFileSync(path, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${path} does not hold one 0x-prefixed 32-byte hex key.`);
  return key;
}

const metadataFile = (image) =>
  new File([JSON.stringify({ name: "Turbo uploader test", description: "testnet", image })], "metadata.json", { type: "application/json" });

/* ------------------------------- flow -------------------------------- */

(async () => {
  const runId = Date.now().toString(36);

  console.log("\n[signed: fresh key, free tier]");
  const fresh = privateKeyToAccount(generatePrivateKey());
  line("address", fresh.address);
  const signed = createTurboUploader({ signer: { ...fresh, recoverPublicKey }, mode: "signed", testnet: true });
  const png = new File([PNG], "pixel.png", { type: "image/png" });
  const img = await signed.upload(png);
  line("png", `${img.url} (${img.size} bytes, ${img.mimeType})`);
  const json = metadataFile(img.url);
  const meta = await signed.upload(json);
  line("json", `${meta.url} (${meta.size} bytes, ${meta.mimeType})`);
  // Auto mode with both paths available: the free signed path, so the same id
  // as above (type 3 signatures are deterministic). maxUsdc 1 cannot pay for anything.
  const auto = await createTurboUploader({ signer: { ...fresh, recoverPublicKey }, maxUsdc: 1n, testnet: true }).upload(png);
  line("auto, png", `${auto.url === img.url ? "signed, same id" : `DIFFERENT: ${auto.url}`}`);
  if (auto.url !== img.url) failures.push(`auto mode returned ${auto.url}, not ${img.url}`);
  let jsonType;
  for (const [label, res, bytes] of [["png", img, PNG], ["json", meta, await json.arrayBuffer()]]) {
    const back = await readBack(res.url, bytes);
    line(`${label} read back`, `${back.same ? "byte-identical" : "DIFFERS"}, content-type "${back.contentType}"`);
    if (!back.same) failures.push(`${label}: read back differs`);
    if (label === "json") jsonType = back.contentType;
  }
  // Zora's check wants the content-type to be exactly application/json. The
  // testnet gateway has answered "application/json; charset=utf-8", which it
  // refuses: a known gap on testnet, and a failure only if the two disagree.
  const exact = jsonType === "application/json";
  const verdict = await zoraCheck(meta.url);
  line("zora check, json", `${verdict}${exact ? "" : " (expected: the gateway adds a charset)"}`);
  if ((verdict === "VALID") !== exact) failures.push(`zora check: ${verdict} with content-type "${jsonType}"`);
  if (!exact) skipped.push(`Zora's metadata check on testnet: ${new URL(meta.url).host} serves JSON as "${jsonType}"`);

  console.log("\n[zora: metadata and image through the uploader]");
  const built = await createMetadataBuilder()
    .withName(`Turbo test ${runId}`)
    .withSymbol("TURBOT")
    .withDescription("Metadata and image stored through @ardrive/turbo-zora-uploader on testnet")
    .withImage(png)
    .upload(signed);
  line("metadata", built.url);
  line("image", built.metadata.image);

  const keyPath = process.env.PAYER_KEY_FILE;
  const payer = keyPath ? privateKeyToAccount(readKey(keyPath)) : fresh;
  const coinArgs = { ...built.createMetadataParameters, creator: payer.address, currency: "ETH", chainId: CHAIN_ID };
  let call;
  try {
    call = await createCoinCall(coinArgs);
    line("createCoinCall", `predicted coin ${call.predictedCoinAddress}`);
  } catch (err) {
    const known = !exact && /not a valid JSON or plain text response type/.test(err.message);
    line("createCoinCall", `${known ? "refused, as expected on testnet" : "FAILED"}: ${err.message}`.slice(0, 400));
    if (!known) failures.push(`createCoinCall: ${err.message}`);
  }

  if (!keyPath) {
    skipped.push("x402 and createCoin: no PAYER_KEY_FILE");
    return;
  }
  const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
  if ((await pub.getChainId()) !== CHAIN_ID) throw new Error(`REFUSING: ${RPC} is not chain ${CHAIN_ID}.`);
  const usdc = () => pub.readContract({ address: SEPOLIA_USDC, abi: erc20Abi, functionName: "balanceOf", args: [payer.address] });
  const usdcStart = await usdc();
  const ethStart = await pub.getBalance({ address: payer.address });
  console.log("\n[payer]");
  line("address", payer.address);
  line("balances", `${formatUnits(usdcStart, 6)} USDC, ${formatEther(ethStart)} ETH`);

  console.log("\n[x402: Base Sepolia USDC]");
  if (usdcStart === 0n) {
    // Quote only: the uploader reaches the 402 and is asked to sign, then stops. Nothing is signed.
    const STOP = new Error("quote only");
    const quoting = { address: payer.address, signTypedData: async (t) => {
      line("402 asks", `${t.message.value} USDC base units, chain ${t.domain.chainId}, domain "${t.domain.name}"`);
      throw STOP;
    } };
    const err = await createTurboUploader({ signer: sepoliaOnly(quoting), mode: "x402", maxUsdc: 200_000n, testnet: true })
      .upload(png)
      .then(() => null, (e) => e);
    if (!err || err.cause !== STOP) failures.push(`x402 quote: ${err ? `${err.name}: ${err.message}` : "uploaded without a signature"}`);
    skipped.push("x402 uploads: the payer holds no Base Sepolia USDC, so the quote was taken and nothing signed");
  } else {
    const maxUsdc = 200_000n; // 0.2 USDC per upload, two uploads, under the 1 USDC cap
    const paid = createTurboUploader({ signer: sepoliaOnly(payer), mode: "x402", maxUsdc, testnet: true });
    for (const [label, file] of [["png", png], ["json", metadataFile(`ar://x402-${runId}`)]]) {
      if (usdcStart - (await usdc()) + maxUsdc > USDC_CAP) {
        skipped.push(`x402 ${label}: would pass the 1 USDC cap`);
        continue;
      }
      try {
        const res = await paid.upload(file, { timeout: 180_000 });
        const back = await readBack(res.url, await file.arrayBuffer());
        line(label, `${res.url} -> ${back.same ? "byte-identical" : "DIFFERS"}, "${back.contentType}"`);
        if (!back.same) failures.push(`x402 ${label}: read back differs`);
      } catch (err) {
        failures.push(`x402 ${label}: ${err.name}: ${err.message}`);
        line(label, `FAILED ${err.name}: ${err.message}`.slice(0, 400));
      }
    }
    line("USDC spent", formatUnits(usdcStart - (await usdc()), 6));
  }

  console.log("\n[zora: createCoin on Base Sepolia]");
  if (!call) {
    skipped.push("createCoin: createCoinCall failed");
  } else if (ethStart === 0n) {
    skipped.push("createCoin: the payer holds no Base Sepolia ETH");
  } else {
    const gas = await pub.estimateGas({ ...call.calls[0], account: payer.address });
    const cost = gas * (await pub.getGasPrice());
    if (cost * 2n > ETH_CAP) {
      skipped.push(`createCoin: estimated ${formatEther(cost)} ETH, over half the 0.02 ETH cap`);
    } else {
      const wallet = createWalletClient({ account: payer, chain: baseSepolia, transport: http(RPC) });
      const res = await createCoin({
        call: coinArgs,
        walletClient: wallet,
        publicClient: pub,
      });
      line("coin", res.address);
      line("tx", res.hash);
      const uri = await pub.readContract({ address: res.address, abi: [{ type: "function", name: "tokenURI", inputs: [], outputs: [{ type: "string" }], stateMutability: "view" }], functionName: "tokenURI" });
      line("tokenURI", uri);
      if (uri !== coinArgs.metadata.uri) failures.push(`tokenURI ${uri} is not ${coinArgs.metadata.uri}`);
      line("ETH spent", formatEther(ethStart - (await pub.getBalance({ address: payer.address }))));
    }
  }
})()
  .then(() => {
    if (skipped.length) console.log(`\nSKIPPED:\n${skipped.map((s) => `  - ${s}`).join("\n")}`);
    if (failures.length) {
      console.log(`\nFAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
      process.exit(1);
    }
    console.log("\nOK");
  })
  .catch((err) => {
    console.error(`\nFAILED: ${err.name}: ${err.message}`);
    process.exit(1);
  });
