/**
 * @ardrive/turbo-zora-uploader: an `Uploader` for the Zora Coins SDK that
 * stores files on Arweave through Turbo.
 *
 * Hand-written declarations. The uploader is structurally the SDK's
 * `Uploader`, so this file imports nothing from the SDK.
 */

import type { EvmSigner, IntegerAmount, Tag, X402Signer } from "@ardrive/turbo-upload";

/** A metadata URI form that the Zora Coins SDK accepts. */
export type ValidMetadataURI = `ipfs://${string}` | `ar://${string}` | `data:${string}` | `https://${string}`;

/**
 * An EVM signer for one or both payment paths. A viem `LocalAccount` spread
 * with viem's `recoverPublicKey` can use both: `{ ...account, recoverPublicKey }`.
 *
 * - Signed path (free tier, then Turbo credits): `address`, `signMessage`,
 *   `recoverPublicKey`, and optionally `publicKey`, which saves a browser
 *   wallet one connect prompt.
 * - x402 path (USDC on Base): `address`, `signTypedData`. A smart-contract
 *   wallet can use only this path.
 */
export type TurboZoraSigner =
  | (EvmSigner & Partial<Pick<X402Signer, "signTypedData">>)
  | (X402Signer & Partial<Omit<EvmSigner, "address">>);

interface CommonOptions {
  /** The account that signs data items, pays with x402, or both. */
  signer: TurboZoraSigner;
  /**
   * If `true`, uploads to the testnet services: small signed items are free, and
   * x402 pays in Base Sepolia USDC. If `false` (the default), uploads to
   * production, where items are permanent and public.
   */
  testnet?: boolean;
  /**
   * The tags added to every item, after the Content-Type tag taken from
   * `file.type`. A Content-Type tag here is refused, and so are tags over 3072
   * bytes when the uploader can pay with x402.
   */
  tags?: Tag[];
  /** The fetch implementation passed to @ardrive/turbo-upload, for tests and proxies. */
  fetch?: typeof fetch;
}

/** The payment mode, and the most an x402 upload may cost. null means absent. */
type ModeOptions =
  | {
      /**
       * The payment mode "auto" (the default): signed when the signer can sign
       * data items and the item fits the free tier, x402 otherwise. When the
       * service refuses a signed item with TurboPaymentError, the file goes to
       * x402 if the signer can pay. A TurboSignerError is thrown.
       */
      mode?: "auto";
      /**
       * The most one x402 upload may cost, in USDC base units (6 decimals):
       * 500000 is 0.50 USDC. A positive whole number. If null or absent, the
       * uploader has no x402 path.
       */
      maxUsdc?: IntegerAmount | null;
    }
  | {
      /** The payment mode "signed": every file is signed, and nothing is paid in USDC. */
      mode: "signed";
      /** Refused with mode "signed". */
      maxUsdc?: null;
    }
  | {
      /** The payment mode "x402": every file is paid for in USDC. Required for a smart-contract wallet. */
      mode: "x402";
      /** The most one upload may cost, in USDC base units (6 decimals): 500000 is 0.50 USDC. */
      maxUsdc: IntegerAmount;
    };

/** The URL form returned for each item. null means absent. */
type UriOptions =
  | {
      /**
       * The "ar" form (the default): `ar://ITEM_ID`. No gateway is assumed.
       * Zora's SDK reads it through arweave.net, which can lag behind a fresh
       * upload, so skip Zora's metadata check for it.
       */
      uri?: "ar";
      /** Refused with uri "ar". */
      gateway?: null;
    }
  | {
      /** The "https" form: `GATEWAY/ITEM_ID`, for a gateway you choose. */
      uri: "https";
      /** The https gateway for the URL, with no query or fragment. Required. */
      gateway: string;
    };

/** The options for `createTurboUploader`. */
export type TurboUploaderOptions = CommonOptions & ModeOptions & UriOptions;

/** What one upload returns: the SDK's `UploadResult`. */
export interface TurboUploadResult {
  /** The item's URL, in the form `uri` chose. */
  url: ValidMetadataURI;
  /** The size of the file, from `file.size`. */
  size: number | undefined;
  /** The file's type, from `file.type`, or undefined when that is empty. */
  mimeType: string | undefined;
}

/** An uploader that is structurally the Zora Coins SDK's `Uploader`. */
export interface TurboUploader {
  /**
   * Uploads one file and returns its URL.
   *
   * @param file The file. Its `type` becomes the item's Content-Type.
   * @param options The abort signal, and `timeout`: a deadline for the whole
   *   upload in milliseconds, where 0 means none, as in the SDK's own uploader.
   *   A negative `timeout` throws TurboConfigError.
   */
  upload(file: File, options?: { signal?: AbortSignal; timeout?: number }): Promise<TurboUploadResult>;
}

/**
 * Creates an uploader for the Zora Coins SDK. Throws TurboConfigError, from
 * @ardrive/turbo-upload, for a bad or unknown option. Production is the
 * default, and URLs are `ar://ITEM_ID` unless `uri` is "https".
 */
export declare function createTurboUploader(options: TurboUploaderOptions): TurboUploader;
