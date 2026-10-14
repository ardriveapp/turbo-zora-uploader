"use strict";
/**
 * createTurboUploader through an injected fetch. No network. Signed items are
 * signed for real with a throwaway viem key, then parsed back off the wire.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Buffer } = require("node:buffer");
const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");
const { recoverPublicKey } = require("viem");
const { parseDataItem, deserializeTags, idFromSignature, PRODUCTION, TESTNET } = require("@ardrive/turbo-upload");

const { createTurboUploader } = require("../index.js");

const account = privateKeyToAccount(generatePrivateKey());
/** Both paths: a viem account plus viem's recoverPublicKey. */
const BOTH = { ...account, recoverPublicKey };
/** Signed only: no signTypedData. */
const SIGNED_ONLY = { address: account.address, publicKey: account.publicKey, signMessage: account.signMessage, recoverPublicKey };
/** x402 only: a viem account, no recoverPublicKey. */
const X402_ONLY = account;

const PAY_TO = "0x9B13eb5096264B12532b8C648Eba4A662b4078ce";
const X402_ROUTE = "/v1/x402/upload/unsigned";
const X402_ID = "x".repeat(43);
const offer = (testnet) => ({
  scheme: "exact",
  network: testnet ? "base-sepolia" : "base",
  maxAmountRequired: "10000",
  resource: "/v1/tx",
  payTo: PAY_TO,
  maxTimeoutSeconds: 3600,
  asset: testnet ? "0x036CbD53842c5426634e7929541eC2318f3dCF7e" : "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  extra: { name: testnet ? "USDC" : "USD Coin", version: "2" },
});

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * A Turbo upload service in one function. Records every request; signed items
 * are parsed so a test can read their id and tags.
 */
function service({ freeLimit = 107520, testnet = false, onTx } = {}) {
  const calls = [];
  let quoted = false;
  const fn = async (url, init = {}) => {
    const { pathname, origin } = new URL(url);
    const call = { url, origin, path: pathname, method: init.method ?? "GET", headers: init.headers ?? {} };
    calls.push(call);
    if (pathname === "/v1/info") return json(200, { freeUploadLimitBytes: freeLimit });
    if (pathname === "/v1/tx") {
      const item = parseDataItem(Buffer.from(init.body));
      call.id = idFromSignature(item.rawSignature).toString("base64url");
      call.tags = item.tagCount ? deserializeTags(item.rawTags) : [];
      call.data = item.rawData;
      if (onTx) return onTx(call, init);
      return json(200, { id: call.id, winc: "0" });
    }
    if (pathname === X402_ROUTE) {
      call.envelope = JSON.parse(Buffer.from(init.body).toString("utf8"));
      if (!init.headers["X-PAYMENT"]) {
        quoted = true;
        return json(402, { x402Version: 1, accepts: [offer(testnet)], error: "Payment required" });
      }
      assert.ok(quoted, "paid only after a quote");
      return json(200, { id: X402_ID, owner: "service", payer: account.address, x402Payment: { paymentId: "p", transactionHash: "0xhash", network: "base" } });
    }
    return json(404, {});
  };
  fn.calls = calls;
  fn.paths = () => calls.map((c) => c.path);
  return fn;
}

const jsonFile = (body = { name: "Coin", description: "d", image: "https://turbo-gateway.com/x" }) =>
  new File([JSON.stringify(body)], "metadata.json", { type: "application/json" });

/* ---------------------------- mode selection ---------------------------- */

test("auto: a small file goes the free signed path", async () => {
  const fetch = service();
  const file = jsonFile();
  const res = await createTurboUploader({ signer: BOTH, maxUsdc: 50_000n, fetch }).upload(file);
  assert.deepEqual(fetch.paths(), ["/v1/info", "/v1/tx"]);
  const tx = fetch.calls[1];
  assert.equal(tx.origin, PRODUCTION.uploadUrl);
  assert.equal(Buffer.from(tx.data).toString("utf8"), await file.text());
  assert.deepEqual(res, { url: `https://turbo-gateway.com/${tx.id}`, size: file.size, mimeType: "application/json" });
});

test("auto: a file over the free limit goes to x402", async () => {
  const fetch = service({ freeLimit: 100 });
  const file = new File([new Uint8Array(500)], "big.png", { type: "image/png" });
  const res = await createTurboUploader({ signer: BOTH, maxUsdc: 50_000n, fetch }).upload(file);
  assert.deepEqual(fetch.paths(), ["/v1/info", X402_ROUTE, X402_ROUTE]);
  assert.equal(res.url, `https://turbo-gateway.com/${X402_ID}`);
});

test("auto: the free limit is the signed item's size, and is read once", async () => {
  const fetch = service({ freeLimit: 400 });
  const uploader = createTurboUploader({ signer: BOTH, maxUsdc: 50_000n, fetch });
  // An EVM item is 150 bytes larger than its data, before tags.
  await uploader.upload(new File([new Uint8Array(200)], "a.png", { type: "image/png" }));
  await uploader.upload(new File([new Uint8Array(300)], "b.png", { type: "image/png" }));
  assert.deepEqual(fetch.paths(), ["/v1/info", "/v1/tx", X402_ROUTE, X402_ROUTE]);
});

test("auto: a signer that cannot pay with x402 always signs, whatever the size", async () => {
  const fetch = service({ freeLimit: 100 });
  await createTurboUploader({ signer: SIGNED_ONLY, fetch }).upload(new File([new Uint8Array(500)], "big.png", { type: "image/png" }));
  assert.deepEqual(fetch.paths(), ["/v1/tx"], "no /v1/info read, nothing to choose between");
});

test("auto: a signer with signTypedData but no maxUsdc signs", async () => {
  const fetch = service();
  await createTurboUploader({ signer: BOTH, fetch }).upload(jsonFile());
  assert.deepEqual(fetch.paths(), ["/v1/tx"]);
});

test("auto: a signer that cannot sign data items pays with x402", async () => {
  const fetch = service();
  await createTurboUploader({ signer: X402_ONLY, maxUsdc: 50_000n, fetch }).upload(jsonFile());
  assert.deepEqual(fetch.paths(), [X402_ROUTE, X402_ROUTE]);
});

test("auto: a spent free quota falls back to x402, and later uploads go there directly", async () => {
  const fetch = service({ onTx: () => json(402, { error: "Insufficient balance" }) });
  const uploader = createTurboUploader({ signer: BOTH, maxUsdc: 50_000n, fetch });
  const first = await uploader.upload(jsonFile());
  assert.equal(first.url, `https://turbo-gateway.com/${X402_ID}`);
  assert.deepEqual(fetch.paths(), ["/v1/info", "/v1/tx", X402_ROUTE, X402_ROUTE]);
  await uploader.upload(jsonFile());
  assert.deepEqual(fetch.paths().slice(4), [X402_ROUTE, X402_ROUTE]);
});

test("auto: a smart-contract wallet's signature is thrown, with the way out, and nothing is paid", async () => {
  const fetch = service();
  const smartWallet = {
    address: account.address,
    signMessage: async () => `0x${"ab".repeat(100)}`, // an ERC-1271 signature, not 65 bytes
    recoverPublicKey,
    signTypedData: account.signTypedData,
  };
  await assert.rejects(createTurboUploader({ signer: smartWallet, maxUsdc: 50_000n, fetch }).upload(jsonFile()), {
    name: "TurboSignerError",
    message: /mode: "x402"/,
  });
  assert.deepEqual(fetch.paths(), ["/v1/info"], "nothing reached /v1/tx or the x402 route");
});

test("x402 mode is the way out for a smart-contract wallet", async () => {
  const fetch = service();
  const smartWallet = { address: account.address, signMessage: async () => `0x${"ab".repeat(100)}`, recoverPublicKey, signTypedData: account.signTypedData };
  const res = await createTurboUploader({ signer: smartWallet, mode: "x402", maxUsdc: 50_000n, fetch }).upload(jsonFile());
  assert.equal(res.url, `https://turbo-gateway.com/${X402_ID}`);
  assert.deepEqual(fetch.paths(), [X402_ROUTE, X402_ROUTE]);
});

test("auto: a wallet that refuses to sign is not asked to pay instead", async () => {
  const fetch = service();
  let typedDataAsked = false;
  const refusing = {
    address: account.address,
    signMessage: async () => {
      throw new Error("User rejected the request.");
    },
    recoverPublicKey,
    signTypedData: async (t) => ((typedDataAsked = true), account.signTypedData(t)),
  };
  await assert.rejects(createTurboUploader({ signer: refusing, maxUsdc: 50_000n, fetch }).upload(jsonFile()), {
    name: "TurboSignerError",
    message: /User rejected/,
  });
  assert.equal(typedDataAsked, false);
  assert.deepEqual(fetch.paths(), ["/v1/info"]);
});

test('"signed": a 402 is thrown, never paid with x402', async () => {
  const fetch = service({ onTx: () => json(402, { error: "Insufficient balance" }) });
  await assert.rejects(createTurboUploader({ signer: BOTH, mode: "signed", maxUsdc: 50_000n, fetch }).upload(jsonFile()), {
    name: "TurboPaymentError",
  });
  assert.deepEqual(fetch.paths(), ["/v1/tx"]);
});

test('"x402": a small file is still paid with x402', async () => {
  const fetch = service();
  await createTurboUploader({ signer: BOTH, mode: "x402", maxUsdc: 50_000n, fetch }).upload(jsonFile());
  assert.deepEqual(fetch.paths(), [X402_ROUTE, X402_ROUTE]);
});

/* ------------------------------ config errors ------------------------------ */

test("x402 without maxUsdc is a startup error", () => {
  assert.throws(() => createTurboUploader({ signer: X402_ONLY, mode: "x402" }), { name: "TurboConfigError", message: /maxUsdc/ });
  assert.throws(() => createTurboUploader({ signer: X402_ONLY }), { name: "TurboConfigError", message: /maxUsdc/ });
});

test("other bad options are startup errors", () => {
  assert.throws(() => createTurboUploader({ signer: X402_ONLY, mode: "signed" }), { name: "TurboConfigError", message: /recoverPublicKey/ });
  assert.throws(() => createTurboUploader({}), { name: "TurboConfigError", message: /signer/ });
  assert.throws(() => createTurboUploader({ signer: BOTH, mode: "free" }), { name: "TurboConfigError", message: /mode/ });
  assert.throws(() => createTurboUploader({ signer: BOTH, uri: "ipfs" }), { name: "TurboConfigError", message: /uri/ });
  assert.throws(() => createTurboUploader({ signer: BOTH, gateway: "http://localhost:3000" }), { name: "TurboConfigError", message: /https/ });
  assert.throws(() => createTurboUploader({ signer: BOTH, uploadUrl: TESTNET.uploadUrl }), {
    name: "TurboConfigError",
    message: /unknown option `uploadUrl`/,
  });
});

/* -------------------------------- URL forms -------------------------------- */

test('uri "ar" returns ar://<id>', async () => {
  const fetch = service();
  const res = await createTurboUploader({ signer: BOTH, uri: "ar", fetch }).upload(jsonFile());
  assert.equal(res.url, `ar://${fetch.calls[0].id}`);
});

test("a custom gateway is used as given, less a trailing slash", async () => {
  const fetch = service();
  const res = await createTurboUploader({ signer: BOTH, gateway: "https://example.com/", fetch }).upload(jsonFile());
  assert.equal(res.url, `https://example.com/${fetch.calls[0].id}`);
});

test("testnet uploads to the testnet service and links to its gateway", async () => {
  const fetch = service({ testnet: true });
  const res = await createTurboUploader({ signer: BOTH, testnet: true, fetch }).upload(jsonFile());
  assert.deepEqual(fetch.calls.map((c) => c.origin), [TESTNET.uploadUrl]);
  assert.equal(res.url, `https://ar-io.dev/${fetch.calls[0].id}`);
});

test("testnet x402 pays on Base Sepolia", async () => {
  const fetch = service({ testnet: true });
  const seen = [];
  const signer = { address: account.address, signTypedData: async (t) => (seen.push(t), account.signTypedData(t)) };
  await createTurboUploader({ signer, testnet: true, maxUsdc: 50_000n, fetch }).upload(jsonFile());
  assert.deepEqual(fetch.calls.map((c) => c.origin), [TESTNET.uploadUrl, TESTNET.uploadUrl]);
  assert.equal(seen[0].domain.chainId, 84532);
});

/* ------------------------------- Content-Type ------------------------------- */

test("the Content-Type tag comes from file.type, and nothing else is added", async () => {
  const fetch = service();
  await createTurboUploader({ signer: BOTH, fetch }).upload(new File([new Uint8Array(10)], "i.png", { type: "image/png" }));
  assert.deepEqual(fetch.calls[0].tags, [{ name: "Content-Type", value: "image/png" }]);
});

test("a file with no type gets no Content-Type tag, and mimeType is undefined", async () => {
  const fetch = service();
  const res = await createTurboUploader({ signer: BOTH, fetch }).upload(new File(["x"], "x"));
  assert.deepEqual(fetch.calls[0].tags, []);
  assert.equal(res.mimeType, undefined);
  assert.equal(res.size, 1);
});

test("extra tags follow the Content-Type tag, on both paths", async () => {
  const tags = [{ name: "App-Name", value: "my-app" }];
  const signed = service();
  await createTurboUploader({ signer: BOTH, tags, fetch: signed }).upload(jsonFile());
  assert.deepEqual(signed.calls[0].tags, [{ name: "Content-Type", value: "application/json" }, ...tags]);

  const paid = service();
  await createTurboUploader({ signer: BOTH, mode: "x402", maxUsdc: 50_000n, tags, fetch: paid }).upload(jsonFile());
  const { contentType, tags: sent } = paid.calls[1].envelope;
  assert.equal(contentType, "application/json");
  assert.deepEqual(sent, tags);
});

/* ---------------------------------- abort ---------------------------------- */

/** A service whose upload routes hang until the request's signal aborts. */
function hanging() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push(new URL(url).pathname);
    if (url.endsWith("/v1/info")) return json(200, { freeUploadLimitBytes: 107520 });
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  fn.calls = calls;
  return fn;
}

test("an already-aborted signal uploads nothing and signs nothing", async () => {
  let signed = false;
  const signer = { ...BOTH, signMessage: async (m) => ((signed = true), account.signMessage(m)) };
  const fetch = service();
  await assert.rejects(createTurboUploader({ signer, fetch }).upload(jsonFile(), { signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(signed, false);
  assert.deepEqual(fetch.calls, []);
});

test("aborting mid-upload rejects, on both paths", async () => {
  for (const mode of ["signed", "x402"]) {
    const fetch = hanging();
    const controller = new AbortController();
    const pending = createTurboUploader({ signer: BOTH, mode, maxUsdc: 50_000n, fetch }).upload(jsonFile(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, { name: "TurboTimeoutError", message: /aborted by the caller's signal/ }, mode);
    assert.equal(fetch.calls.length, 1, `${mode}: the aborted request is not retried`);
  }
});

test("timeout bounds the whole upload", async () => {
  const fetch = hanging();
  const t0 = Date.now();
  await assert.rejects(createTurboUploader({ signer: BOTH, fetch }).upload(jsonFile(), { timeout: 100 }), { name: "TurboTimeoutError" });
  assert.ok(Date.now() - t0 < 5000);
});

/* ------------------------------- dependencies ------------------------------- */

test("one runtime dependency: @ardrive/turbo-upload", () => {
  const pkg = require("../package.json");
  assert.deepEqual(Object.keys(pkg.dependencies), ["@ardrive/turbo-upload"]);
  assert.equal(pkg.peerDependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
});

test("the README quickstart is test/types/quickstart.ts, which `npm run types` compiles", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const block = readme.match(/## Quickstart\n\n```ts\n([\s\S]*?)```/)[1];
  assert.equal(block, fs.readFileSync(path.join(__dirname, "types", "quickstart.ts"), "utf8"));
});
