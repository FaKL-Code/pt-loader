import type { PTPreviewKind } from './preview.js';

export interface PTPreviewServerContext {
  request: Request;
  assetId: string;
  kind: PTPreviewKind;
}

export interface PTPreviewRenderContext {
  request: Request;
  /** Private value returned by `resolveAsset`; never sent to the client. */
  asset: unknown;
  assetId: string;
  kind: PTPreviewKind;
  viewport: { width: number; height: number; pixelRatio: number };
  options: Record<string, unknown>;
  state: Record<string, unknown>;
  principal: unknown;
}

export interface PTPreviewFrameResult {
  body: ArrayBuffer | Uint8Array | Blob;
  contentType: string;
}

export interface PTPreviewHandlerOptions {
  /** Resolve an opaque id through an allowlist/private storage layer. */
  resolveAsset(context: PTPreviewServerContext): unknown | Promise<unknown>;
  /** Render privately and return only an image frame. */
  renderFrame(
    context: PTPreviewRenderContext,
  ): PTPreviewFrameResult | Promise<PTPreviewFrameResult>;
  /** Return null/false/undefined to reject the request. */
  authenticate?(request: Request): unknown | Promise<unknown>;
  /** Stable identity used to bind a session to its owner. */
  principalKey?(principal: unknown): string;
  basePath?: string;
  sessionTtlMs?: number;
  maxSessions?: number;
  maxFrameBytes?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * Framework-neutral server handler for `pt-preview-v1`. Adapt your framework's
 * request/response objects to the Web Fetch API at the application boundary.
 */
export function createPreviewHandler(
  options: PTPreviewHandlerOptions,
): (request: Request) => Promise<Response>;
