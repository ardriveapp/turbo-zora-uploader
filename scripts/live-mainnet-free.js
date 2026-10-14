"use strict";
/**
 * One free signed upload to production, then Zora's metadata check on its
 * https URL. Production uploads are permanent and public, so this needs a flag.
 * Not part of the package.
 *
 *   node scripts/live-mainnet-free.js --yes-mainnet
 *
 * A fresh random key, so the free quota is its own and nothing is paid. The
 * signer has no signTypedData and there is no maxUsdc, so the uploader cannot
 * take the x402 path; the guarded fetch refuses it and the payment service as
 * well. The item is checked to be under the free size before it is signed.
 *
 * Then createCoinCall on Base Sepolia (calldata only, no transaction), which
 * runs the same metadata check inside the SDK before it asks Zora's API.
 */

const { recoverPublicKey } = require("viem");
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");

const ALLOWED_HOSTS = new Set(["upload.ardrive.io", "turbo-gateway.com", "api-sdk.zora.engineering"]);
const FREE_ITEM_BYTES = 107520;
let receipt;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!ALLOWED_HOSTS.has(url.hostname) || url.pathname.includes("x402")) throw new Error(`REFUSING: ${url.href} is not a free-tier request.`);
  const res = await realFetch(input, init);
  if (url.pathname === "/v1/tx") receipt = await res.clone().json().catch(() => undefined);
  return res;
};

const { createTurboUploader } = require("..");
const { createCoinCall, validateMetadataURIContent } = require("@zoralabs/coins-sdk");

if (!process.argv.includes("--yes-mainnet")) {
  console.error("This writes one permanent, public item to production. Pass --yes-mainnet.");
  process.exit(2);
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const line = (k, v) => console.log(`    ${k.padEnd(26)} ${v}`);

(async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = { address: account.address, publicKey: account.publicKey, signMessage: account.signMessage, recoverPublicKey };
  const uploader = createTurboUploader({ signer, mode: "signed" });

  const metadata = {
    name: "Turbo Zora uploader check",
    description: "Coin metadata stored on Arweave through @ardrive/turbo-zora-uploader",
    image: `data:image/png;base64,${PNG}`,
  };
  const file = new File([JSON.stringify(metadata)], "metadata.json", { type: "application/json" });
  // An EVM item is 150 bytes over its data, plus the Content-Type tag.
  if (file.size + 150 + 64 > FREE_ITEM_BYTES) throw new Error("REFUSING: the item would not be free.");

  console.log("\n[production: one free signed upload]");
  line("address", account.address);
  const res = await uploader.upload(file, { timeout: 120_000 });
  line("url", res.url);
  line("size, type", `${res.size} bytes, ${res.mimeType}`);
  line("winc charged", receipt?.winc ?? "(not reported)");
  if (receipt?.winc && receipt.winc !== "0") throw new Error(`charged ${receipt.winc} winc`);

  const t0 = Date.now();
  let verdict;
  for (let i = 0; i < 24; i++) {
    try {
      await validateMetadataURIContent(res.url);
      verdict = `VALID after ${((Date.now() - t0) / 1000).toFixed(1)} s`;
      break;
    } catch (err) {
      verdict = `refused: ${err.message}`;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  line("zora check", verdict);

  try {
    const call = await createCoinCall({
      creator: account.address,
      name: metadata.name,
      symbol: "TZUC",
      metadata: { type: "RAW_URI", uri: res.url },
      currency: "ETH",
      chainId: 84532,
    });
    line("createCoinCall, 84532", `predicted coin ${call.predictedCoinAddress}`);
  } catch (err) {
    // The metadata check runs first, so any other message means it passed.
    line("createCoinCall, 84532", `${err.message}`.slice(0, 300));
  }
  process.exit(verdict.startsWith("VALID") ? 0 : 1);
})().catch((err) => {
  console.error(`\nFAILED: ${err.name}: ${err.message}`);
  process.exit(1);
});
