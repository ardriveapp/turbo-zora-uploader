"use strict";
/**
 * @ardrive/turbo-zora-uploader: an `Uploader` for the Zora Coins SDK that
 * stores files on Arweave through Turbo. One runtime dependency,
 * @ardrive/turbo-upload, which has none.
 *
 * `Uploader` is a structural type, so nothing here imports the Zora SDK.
 */

const {
  TurboUpload,
  uploadUnsignedX402,
  serializeTags,
  PRODUCTION,
  TESTNET,
  TurboConfigError,
  TurboPaymentError,
  TurboSignerError,
} = require("@ardrive/turbo-upload");

const OPTIONS = ["signer", "mode", "maxUsdc", "uri", "gateway", "testnet", "tags", "fetch"];
const MODES = ["auto", "signed", "x402"];
const URIS = ["https", "ar"];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const configError = (message) => new TurboConfigError(`createTurboUploader: ${message}`);

/** USDC base units as turbo-upload takes them: a positive integer, as a bigint, a number or a digit string. */
function isBaseUnits(value) {
  if (typeof value === "bigint") return value > 0n;
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  return typeof value === "string" && /^[0-9]+$/.test(value) && BigInt(value) > 0n;
}

/**
 * @param {import("./index").TurboUploaderOptions} options
 * @returns {import("./index").TurboUploader}
 */
function createTurboUploader(options) {
  if (options === null || typeof options !== "object") throw configError("takes an options object with at least `signer`.");
  const unknown = Object.keys(options).filter((k) => !OPTIONS.includes(k));
  if (unknown.length) throw configError(`unknown option ${unknown.map((k) => `\`${k}\``).join(", ")}. Accepted: ${OPTIONS.join(", ")}.`);
  const { signer, mode = "auto", maxUsdc, uri = "https", testnet = false, tags = [], fetch } = options;

  if (!MODES.includes(mode)) throw configError(`\`mode\` must be one of ${MODES.join(", ")}, got ${JSON.stringify(mode)}.`);
  if (!URIS.includes(uri)) throw configError(`\`uri\` must be "https" or "ar", got ${JSON.stringify(uri)}.`);
  if (typeof testnet !== "boolean") throw configError("`testnet` must be true or false.");
  if (fetch !== undefined && typeof fetch !== "function") throw configError("`fetch` must be a function.");
  if (maxUsdc !== undefined && maxUsdc !== null && !isBaseUnits(maxUsdc)) {
    throw configError(`\`maxUsdc\` must be a positive whole number of USDC base units (6 decimals: 0.05 USDC is 50000), got ${typeof maxUsdc === "bigint" ? `${maxUsdc}n` : JSON.stringify(maxUsdc)}.`);
  }
  try {
    serializeTags(tags);
  } catch (err) {
    throw configError(`\`tags\` must be an array of { name, value } strings: ${err.message}.`);
  }
  if (tags.some((t) => t.name.toLowerCase() === "content-type")) {
    throw configError("`tags` cannot carry Content-Type: it comes from `file.type`. Set the File's type instead.");
  }

  const endpoints = testnet ? TESTNET : PRODUCTION;
  if (options.gateway !== undefined) {
    if (uri === "ar") throw configError('`gateway` has no effect with uri "ar". Pass one or the other.');
    if (typeof options.gateway !== "string" || !/^https:\/\/[^/?#]+(\/[^?#]*)?$/.test(options.gateway)) {
      throw configError(`\`gateway\` must be an https:// URL with no query or fragment, which Zora accepts as a metadata URI, got ${JSON.stringify(options.gateway)}.`);
    }
  }
  // Testnet items are served by the testnet gateway, not by turbo-gateway.com.
  const gateway = (options.gateway ?? endpoints.gatewayUrl).replace(/\/+$/, "");

  if (!signer || typeof signer !== "object") {
    throw configError("`signer` is required: an EVM account with signMessage and recoverPublicKey, signTypedData, or both.");
  }
  if (typeof signer.address !== "string" || !ADDRESS.test(signer.address)) {
    throw configError(`\`signer.address\` must be a 0x-prefixed 20-byte hex address, got ${JSON.stringify(signer.address)}.`);
  }
  const canSign = typeof signer.signMessage === "function" && typeof signer.recoverPublicKey === "function";
  const canPay = typeof signer.signTypedData === "function" && maxUsdc !== undefined && maxUsdc !== null;
  if (mode === "signed" && !canSign) throw configError('mode "signed" needs `signer.signMessage` and `signer.recoverPublicKey` (viem exports recoverPublicKey).');
  if (mode === "x402" && !canPay) throw configError('mode "x402" needs `signer.signTypedData` and `maxUsdc`, the most one upload may pay in USDC base units.');
  if (mode === "auto" && !canSign && !canPay) {
    throw configError(
      "this signer can neither sign data items (signMessage plus recoverPublicKey) nor pay with x402 " +
        "(signTypedData plus `maxUsdc`, the most one upload may pay in USDC base units).",
    );
  }

  const withFetch = fetch ? { fetch } : {};
  // Constructed now so a bad signer is a startup error. Signs nothing until the first upload.
  const client = canSign && mode !== "x402"
    ? new TurboUpload({ signer, token: "base-eth", uploadUrl: endpoints.uploadUrl, paymentUrl: endpoints.paymentUrl, ...withFetch })
    : undefined;

  // The free item size is service policy (testnet's is larger), so it is read
  // from /v1/info and kept. A failed read fails the upload and is read again next time.
  let freeLimit;
  // After one fallback, later uploads go to x402 directly.
  let signedFailed = false;

  const viaX402 = async (data, itemTags, signal) => {
    const res = await uploadUnsignedX402({ data, tags: itemTags, signer, maxUsdc, uploadUrl: endpoints.uploadUrl, signal, ...withFetch });
    return res.id;
  };

  return {
    async upload(file, { signal, timeout } = {}) {
      if (timeout !== undefined && !(typeof timeout === "number" && timeout >= 0 && Number.isFinite(timeout))) {
        throw new TurboConfigError(`upload(): \`timeout\` must be a number of milliseconds, 0 or more (0 is none), got ${JSON.stringify(timeout)}.`);
      }
      // As in the SDK's own uploader, 0 means no timeout.
      const signals = [signal, timeout ? AbortSignal.timeout(timeout) : undefined].filter(Boolean);
      const bounded = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
      bounded?.throwIfAborted();

      const data = new Uint8Array(await file.arrayBuffer());
      const itemTags = [...(file.type ? [{ name: "Content-Type", value: file.type }] : []), ...tags];

      let path = mode;
      if (mode === "auto") {
        if (!canPay) path = "signed";
        else if (!canSign || signedFailed) path = "x402";
        else {
          freeLimit ??= await client.getFreeUploadLimitBytes({ signal: bounded });
          path = client.getDataItemSize({ data, tags: itemTags }) <= freeLimit ? "signed" : "x402";
        }
      }
      // Before the wallet is asked to sign anything.
      bounded?.throwIfAborted();

      let id;
      if (path === "signed") {
        try {
          ({ id } = await client.upload({ data, tags: itemTags, signal: bounded }));
        } catch (err) {
          if (err instanceof TurboSignerError) {
            throw new TurboSignerError(`${err.message} For a smart-contract wallet, pass mode: "x402".`, { cause: err });
          }
          // The service refused the signed item with a 402: the free quota is
          // spent and credits are short. Nothing was stored.
          if (!(mode === "auto" && canPay && err instanceof TurboPaymentError)) throw err;
          signedFailed = true;
          id = await viaX402(data, itemTags, bounded);
        }
      } else {
        id = await viaX402(data, itemTags, bounded);
      }

      return {
        url: uri === "ar" ? `ar://${id}` : `${gateway}/${id}`,
        size: file.size,
        mimeType: file.type || undefined,
      };
    },
  };
}

module.exports = { createTurboUploader };
