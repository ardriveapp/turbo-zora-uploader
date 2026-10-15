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
const URIS = ["auto", "ar", "https"];
const MAX_TIMEOUT_MS = 2 ** 32 - 1;
// An https URL with a host, an optional path, and no credentials, spaces, query or fragment.
const GATEWAY = /^https:\/\/[^/?#@\s]+(\/[^?#\s]*)?$/i;

/** The signals combined. AbortSignal.any is missing from older browsers, such as Safari before 17.4. */
function anySignal(signals) {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

/** Whether a file is the coin's metadata JSON, which Zora's builder uploads as application/json. */
const isJson = (file) => file.type.split(";")[0].trim().toLowerCase() === "application/json";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const X402_MAX_TAG_BYTES = 3072;

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
  // null means absent, for every option.
  options = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== null));
  const unknown = Object.keys(options).filter((k) => !OPTIONS.includes(k));
  if (unknown.length) throw configError(`unknown option ${unknown.map((k) => `\`${k}\``).join(", ")}. Accepted: ${OPTIONS.join(", ")}.`);
  const { signer, mode = "auto", maxUsdc, uri = "auto", testnet = false, tags = [], fetch } = options;

  if (!MODES.includes(mode)) throw configError(`\`mode\` must be one of ${MODES.join(", ")}, got ${JSON.stringify(mode)}.`);
  if (!URIS.includes(uri)) throw configError(`\`uri\` must be "auto", "ar" or "https", got ${JSON.stringify(uri)}.`);
  if (typeof testnet !== "boolean") throw configError("`testnet` must be true or false.");
  if (fetch !== undefined && typeof fetch !== "function") throw configError("`fetch` must be a function.");
  if (maxUsdc !== undefined && !isBaseUnits(maxUsdc)) {
    throw configError(`\`maxUsdc\` must be a positive whole number of USDC base units (6 decimals: 0.05 USDC is 50000), got ${typeof maxUsdc === "bigint" ? `${maxUsdc}n` : JSON.stringify(maxUsdc)}.`);
  }
  if (mode === "signed" && maxUsdc !== undefined) throw configError('`maxUsdc` has no effect with mode "signed", which never pays in USDC. Drop one.');
  let tagBytes;
  try {
    tagBytes = serializeTags(tags).length;
  } catch (err) {
    throw configError(`\`tags\` must be an array of { name, value } strings: ${err.message}.`);
  }
  if (tags.some((t) => t.name.toLowerCase() === "content-type")) {
    throw configError("`tags` cannot carry Content-Type: it comes from `file.type`. Set the File's type instead.");
  }

  const endpoints = testnet ? TESTNET : PRODUCTION;
  if (uri === "ar" && options.gateway !== undefined) {
    throw configError('`gateway` has no effect with uri "ar". Drop one.');
  }
  if (options.gateway !== undefined && (typeof options.gateway !== "string" || !GATEWAY.test(options.gateway))) {
    throw configError(`\`gateway\` must be an https:// URL with no credentials, spaces, query or fragment, got ${JSON.stringify(options.gateway)}.`);
  }
  // The production gateway serves a fresh item as exactly application/json,
  // which Zora's metadata check needs. The testnet gateway adds a charset.
  // Zora accepts an https URI only if it starts with "https://" in lower case.
  const gateway = `https://${(options.gateway ?? endpoints.gatewayUrl).slice(8).replace(/\/+$/, "")}`;

  if (!signer || typeof signer !== "object") {
    throw configError("`signer` is required: an EVM account with signMessage and recoverPublicKey, signTypedData, or both.");
  }
  if (typeof signer.address !== "string" || !ADDRESS.test(signer.address)) {
    throw configError(`\`signer.address\` must be a 0x-prefixed 20-byte hex address, got ${JSON.stringify(signer.address)}.`);
  }
  for (const method of ["signMessage", "recoverPublicKey", "signTypedData"]) {
    if (signer[method] !== undefined && typeof signer[method] !== "function") {
      throw configError(`\`signer.${method}\` must be a function, got ${typeof signer[method]}.`);
    }
  }
  const canSign = typeof signer.signMessage === "function" && typeof signer.recoverPublicKey === "function";
  const canPay = typeof signer.signTypedData === "function" && maxUsdc !== undefined && mode !== "signed";
  if (mode === "signed" && !canSign) throw configError('mode "signed" needs `signer.signMessage` and `signer.recoverPublicKey` (viem exports recoverPublicKey).');
  if (mode === "x402" && !canPay) throw configError('mode "x402" needs `signer.signTypedData` and `maxUsdc`, the most one upload may pay in USDC base units.');
  if (mode === "auto" && !canSign && !canPay) {
    throw configError(
      "this signer can neither sign data items (signMessage plus recoverPublicKey) nor pay with x402 " +
        "(signTypedData plus `maxUsdc`, the most one upload may pay in USDC base units).",
    );
  }
  // x402 carries at most 3072 bytes of caller tags, so that the service's own tags still fit the item.
  if (canPay && tagBytes > X402_MAX_TAG_BYTES) {
    throw configError(`\`tags\` take ${tagBytes} bytes; an x402 upload carries at most ${X402_MAX_TAG_BYTES}.`);
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
      if (timeout !== undefined && !(typeof timeout === "number" && timeout >= 0 && timeout <= MAX_TIMEOUT_MS)) {
        throw new TurboConfigError(`upload(): \`timeout\` must be a number of milliseconds from 0 (none) to ${MAX_TIMEOUT_MS}, got ${String(timeout)}.`);
      }
      // As in the SDK's own uploader, 0 means no timeout.
      const signals = [signal, timeout ? AbortSignal.timeout(timeout) : undefined].filter(Boolean);
      const bounded = signals.length > 1 ? anySignal(signals) : signals[0];
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
        // Zora's create API takes only an https or ipfs metadata pointer, so
        // the JSON is on the gateway; media stays ar://, which names no gateway.
        url: uri === "https" || (uri === "auto" && isJson(file)) ? `${gateway}/${id}` : `ar://${id}`,
        size: file.size,
        mimeType: file.type || undefined,
      };
    },
  };
}

module.exports = { createTurboUploader };
