/**
 * @ardrive/turbo-zora-uploader: an `Uploader` for the Zora Coins SDK that
 * stores files on Arweave through Turbo.
 *
 * Hand-written declarations. The result is structurally the SDK's `Uploader`,
 * so this file imports nothing from the SDK.
 */

import type { EvmSigner, IntegerAmount, Tag, X402Signer } from "@ardrive/turbo-upload";

/** The metadata URI forms the Zora Coins SDK accepts. */
export type ValidMetadataURI = `ipfs://${string}` | `ar://${string}` | `data:${string}` | `https://${string}`;

/**
 * An EVM signer for one or both payment paths. A viem `LocalAccount` spread
 * with viem's `recoverPublicKey` can do both: `{ ...account, recoverPublicKey }`.
 *
 * - signed (free tier, then Turbo credits): `address`, `signMessage`, `recoverPublicKey`, optional `publicKey`.
 * - x402 (USDC on Base): `address`, `signTypedData`.
 */
export type TurboZoraSigner =
  | (EvmSigner & Partial<Pick<X402Signer, "signTypedData">>)
  | (X402Signer & Partial<Omit<EvmSigner, "address">>);

export interface TurboUploaderOptions {
  signer: TurboZoraSigner;
  /**
   * "auto" (default): signed when the signer can sign data items and the item
   * fits the free tier, x402 otherwise. A signed upload that fails because the
   * address cannot pay, or because the wallet cannot sign data items, goes to
   * x402 when `maxUsdc` is set.
   */
  mode?: "auto" | "signed" | "x402";
  /** The most one x402 upload may pay, in USDC base units (6 decimals): 50000 is 0.05 USDC. Required for x402. */
  maxUsdc?: IntegerAmount;
  /** "https" (default): `<gateway>/<id>`, which Zora's metadata check reads within seconds. "ar": `ar://<id>`. */
  uri?: "https" | "ar";
  /** An https:// gateway for "https" URLs. Default https://turbo-gateway.com, or https://ar-io.dev with `testnet`. */
  gateway?: string;
  /** Upload to the testnet services: free signed items, x402 paid in Base Sepolia USDC. Default false. */
  testnet?: boolean;
  /** Tags added to every item, after the Content-Type tag taken from `file.type`. */
  tags?: Tag[];
  /** Passed to @ardrive/turbo-upload: tests and proxies. */
  fetch?: typeof fetch;
}

export interface TurboUploadResult {
  url: ValidMetadataURI;
  /** `file.size`. */
  size: number | undefined;
  /** `file.type`, or undefined when it is empty. */
  mimeType: string | undefined;
}

/** Structurally the Zora Coins SDK's `Uploader`. */
export interface TurboUploader {
  /** `timeout` is a deadline for the whole upload, in milliseconds, as in the SDK's own uploader. */
  upload(file: File, options?: { signal?: AbortSignal; timeout?: number }): Promise<TurboUploadResult>;
}

/** Throws a TurboConfigError from @ardrive/turbo-upload for a bad or unknown option. */
export declare function createTurboUploader(options: TurboUploaderOptions): TurboUploader;
