import type { PTAssetRequestInit } from './index.js';

export const PT_PREVIEW_PROTOCOL: 'pt-preview-v1';

export type PTPreviewKind = 'model' | 'character' | 'stage';

export interface PTPreviewSession {
  sessionId: string;
  expiresAt: string | null;
}

export interface PTPreviewFrame {
  blob: Blob;
  /** Object URL for an `<img>`/`<canvas>` consumer, or `null` outside browsers. */
  url: string | null;
  contentType: string;
}

export interface PTPreviewClientOptions {
  /** Base URL of the preview API, not a directory containing assets. */
  endpoint: string;
  fetch?: typeof fetch;
  /** Credentials or short-lived authorization for preview API calls. */
  requestInit?: PTAssetRequestInit;
  /** Maximum accepted rendered frame size. Default: 8 MiB. */
  maxFrameBytes?: number;
}

export interface PTPreviewOpenOptions {
  kind?: PTPreviewKind;
  width?: number;
  height?: number;
  pixelRatio?: number;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export class PTPreviewError extends Error {
  readonly name: 'PTPreviewError';
  readonly code: string;
  readonly status: number;
  readonly operation: string;
}

/**
 * Client for server-rendered previews. It receives image frames only; the
 * server must keep models, textures and manifests private.
 */
export class PTPreviewClient {
  constructor(options: PTPreviewClientOptions);
  readonly endpoint: string;
  readonly maxFrameBytes: number;
  readonly session: PTPreviewSession | null;
  readonly frame: PTPreviewFrame | null;

  open(assetId: string, options?: PTPreviewOpenOptions): Promise<PTPreviewSession>;
  render(
    state?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<PTPreviewFrame>;
  close(options?: { signal?: AbortSignal }): Promise<void>;
  /** Release the local object URL without making a network request. */
  dispose(): void;
}
