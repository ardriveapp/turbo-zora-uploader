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
  PRODUCTION,
  TESTNET,
  TurboConfigError,
  TurboPaymentError,
  TurboSignerError,
} = require("@ardrive/turbo-upload");

const OPTIONS = ["signer", "mode", "maxUsdc", "uri", "gateway", "testnet", "tags", "fetch"];
const MODES = ["auto", "signed", "x402"];
const URIS = ["https", "ar"];

/**
 * @param {import("./index").TurboUploaderOptions} options
 * @returns {import("./index").TurboUploader}
 */
function createTurboUploader(options = {}) {
  const unknown = Object.keys(options).filter((k) => !OPTIONS.includes(k));
  if (unknown.length) {
    throw new TurboConfigError(`createTurboUploader: unknown option ${unknown.map((k) => `\`${k}\``).join(", ")}. Accepted: ${OPTIONS.join(", ")}.`);
  }
  const { signer, mode = "auto", maxUsdc, uri = "https", testnet = false, tags = [], fetch } = options;
  if (!MODES.includes(mode)) throw new TurboConfigError(`createTurboUploader: \`mode\` must be one of ${MODES.join(", ")}, got ${JSON.stringify(mode)}.`);
  if (!URIS.includes(uri)) throw new TurboConfigError(`createTurboUploader: \`uri\` must be "https" or "ar", got ${JSON.stringify(uri)}.`);
  if (typeof testnet !== "boolean") throw new TurboConfigError("createTurboUploader: `testnet` must be true or false.");
  if (!Array.isArray(tags)) throw new TurboConfigError("createTurboUploader: `tags` must be an array of { name, value }.");
  if (!signer || typeof signer !== "object") {
    throw new TurboConfigError("createTurboUploader: `signer` is required: an EVM account with signMessage and recoverPublicKey, signTypedData, or both.");
  }

  const endpoints = testnet ? TESTNET : PRODUCTION;
  // Testnet items are served by the testnet gateway, not by turbo-gateway.com.
  const gateway = String(options.gateway ?? endpoints.gatewayUrl).replace(/\/+$/, "");
  if (!gateway.startsWith("https://")) {
    throw new TurboConfigError(`createTurboUploader: \`gateway\` must be an https:// URL, which Zora accepts as a metadata URI, got ${JSON.stringify(gateway)}.`);
  }

  const canSign = typeof signer.signMessage === "function" && typeof signer.recoverPublicKey === "function";
  const canPay = typeof signer.signTypedData === "function" && maxUsdc !== undefined && maxUsdc !== null;
  if (mode === "signed" && !canSign) {
    throw new TurboConfigError('createTurboUploader: mode "signed" needs `signer.signMessage` and `signer.recoverPublicKey` (viem exports recoverPublicKey).');
  }
  if (mode === "x402" && !canPay) {
    throw new TurboConfigError('createTurboUploader: mode "x402" needs `signer.signTypedData` and `maxUsdc`, the most one upload may pay in USDC base units.');
  }
  if (mode === "auto" && !canSign && !canPay) {
    throw new TurboConfigError(
      "createTurboUploader: this signer can neither sign data items (signMessage plus recoverPublicKey) nor pay with x402 " +
        "(signTypedData plus `maxUsdc`, the most one upload may pay in USDC base units).",
    );
  }

  const withFetch = fetch ? { fetch } : {};
  // Constructed now so a bad signer is a startup error. Signs nothing until the first upload.
  const client = canSign && mode !== "x402"
    ? new TurboUpload({ signer, token: "base-eth", uploadUrl: endpoints.uploadUrl, paymentUrl: endpoints.paymentUrl, ...withFetch })
    : undefined;

  // The free item size is service policy (testnet's is larger), so it is read from /v1/info and kept.
  let freeLimit;

  // After one fallback, later uploads go to x402 directly.
  let signedFailed = false;

  const viaX402 = async (data, itemTags, signal) => {
    const res = await uploadUnsignedX402({ data, tags: itemTags, signer, maxUsdc, uploadUrl: endpoints.uploadUrl, signal, ...withFetch });
    return res.id;
  };

  return {
    async upload(file, { signal, timeout } = {}) {
      const signals = [signal, timeout === undefined ? undefined : AbortSignal.timeout(timeout)].filter(Boolean);
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
      bounded?.throwIfAborted();

      let id;
      if (path === "signed") {
        try {
          ({ id } = await client.upload({ data, tags: itemTags, signal: bounded }));
        } catch (err) {
          if (err instanceof TurboSignerError) {
            throw new TurboSignerError(`${err.message} For a smart-contract wallet, pass mode: "x402".`, { cause: err });
          }
          // A 402 means the free quota is spent and credits are short. Nothing was uploaded.
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
