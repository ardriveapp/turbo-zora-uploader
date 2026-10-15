"use strict";
/**
 * Zora's default flow against production, with nothing paid and nothing sent
 * on chain. Production uploads are permanent and public, so this needs a flag.
 * Not part of the package.
 *
 *   node scripts/live-mainnet-free.js --yes-mainnet
 *
 * A fresh random key signs two free items through the default uploader: a
 * 1x1 PNG and the metadata JSON that Zora's builder makes. The signer has no
 * signTypedData and there is no maxUsdc, so the uploader cannot take the x402
 * path; the guarded fetch refuses it and the payment service as well.
 *
 * Then createCoinCall for Base (8453), with the metadata check on. It returns
 * calldata and sends nothing: no wallet client exists here.
 */

const { recoverPublicKey } = require("viem");
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");

const ALLOWED_HOSTS = new Set(["upload.ardrive.io", "turbo-gateway.com", "api-sdk.zora.engineering"]);
const FREE_ITEM_BYTES = 107520;
const receipts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!ALLOWED_HOSTS.has(url.hostname) || url.pathname.includes("x402")) throw new Error(`REFUSING: ${url.href} is not a free-tier request.`);
  const res = await realFetch(input, init);
  if (url.pathname === "/v1/tx") receipts.push(await res.clone().json().catch(() => ({})));
  return res;
};

const { createTurboUploader } = require("..");
const { createCoinCall, createMetadataBuilder } = require("@zoralabs/coins-sdk");

if (!process.argv.includes("--yes-mainnet")) {
  console.error("This writes permanent, public items to production. Pass --yes-mainnet.");
  process.exit(2);
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const line = (k, v) => console.log(`    ${k.padEnd(26)} ${v}`);

(async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = { address: account.address, publicKey: account.publicKey, signMessage: account.signMessage, recoverPublicKey };
  const uploader = createTurboUploader({ signer, mode: "signed" });
  const free = {
    async upload(file, options) {
      // An EVM item is 150 bytes over its data, plus the Content-Type tag.
      if (file.size + 150 + 64 > FREE_ITEM_BYTES) throw new Error(`REFUSING: ${file.name} would not be free.`);
      return uploader.upload(file, options);
    },
  };

  console.log("\n[production: the default flow, free signed items]");
  line("address", account.address);
  const built = await createMetadataBuilder()
    .withName("Turbo Zora uploader check")
    .withSymbol("TZUC")
    .withDescription("Coin metadata stored on Arweave through @ardrive/turbo-zora-uploader")
    .withImage(new File([PNG], "pixel.png", { type: "image/png" }))
    .upload(free);
  const pointer = built.createMetadataParameters.metadata.uri;
  line("metadata pointer", pointer);
  line("image", built.metadata.image);
  line("winc charged", receipts.map((r) => r.winc ?? "(not reported)").join(", "));
  if (receipts.some((r) => r.winc && r.winc !== "0")) throw new Error("an item was charged");
  if (!pointer.startsWith("https://turbo-gateway.com/") || !built.metadata.image.startsWith("ar://")) {
    throw new Error("the default flow did not give an https pointer with ar:// media");
  }

  // The metadata check runs inside createCoinCall; a fresh item might take a moment to be served.
  const t0 = Date.now();
  for (let i = 1; ; i++) {
    try {
      const call = await createCoinCall({ ...built.createMetadataParameters, creator: account.address, currency: "ETH", chainId: 8453 });
      line("createCoinCall, 8453", `calldata after ${((Date.now() - t0) / 1000).toFixed(1)} s, attempt ${i}`);
      line("predicted coin", call.predictedCoinAddress);
      line("call", `to ${call.calls[0].to}, value ${call.calls[0].value}, ${call.calls[0].data.length} hex chars`);
      process.exit(0);
    } catch (err) {
      line(`attempt ${i}`, err.message.slice(0, 200));
      if (i === 12) process.exit(1);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
})().catch((err) => {
  console.error(`\nFAILED: ${err.name}: ${err.message}`);
  process.exit(1);
});
