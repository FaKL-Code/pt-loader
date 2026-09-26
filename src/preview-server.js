import { randomUUID } from 'node:crypto';

import { PT_PREVIEW_PROTOCOL } from './preview.js';
import { readResponseBytes } from './io/fetch.js';

const MAX_ID_LENGTH = 128;
const MAX_STATE_BYTES = 64 * 1024;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 1000;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const FRAME_TYPES = new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp']);

/**
 * Create a Web Fetch API handler for the `pt-preview-v1` contract.
 *
 * The handler is framework-agnostic: adapt an Express/Next/Fastify request to
 * a standard `Request`, call the returned function, and write its `Response`.
 * `resolveAsset` and `renderFrame` run on the server and may access private
 * storage. Their return values are never serialised into the browser response.
 *
 * @param {object} opts
 * @param {(context: {request: Request, assetId: string, kind: string, viewport: object, options: object}) => unknown|Promise<unknown>} opts.resolveAsset
 * @param {(context: {request: Request, signal: AbortSignal, asset: unknown, assetId: string, kind: string, viewport: object, options: object, state: object, principal: unknown}) => {body: ArrayBuffer|Uint8Array|Blob, contentType: string}|Promise<{body: ArrayBuffer|Uint8Array|Blob, contentType: string}>} opts.renderFrame
 * @param {(request: Request) => unknown|Promise<unknown>} [opts.authenticate] return null/false to reject
 * @param {(principal: unknown) => string} [opts.principalKey]
 * @param {string} [opts.basePath='/api/previews']
 * @param {number} [opts.sessionTtlMs=300000]
 * @param {number} [opts.maxSessions=1000]
 * @param {number} [opts.maxFrameBytes=8388608]
 * @param {() => number} [opts.now] test clock in milliseconds
 * @returns {(request: Request) => Promise<Response>}
 */
export function createPreviewHandler({
  resolveAsset,
  renderFrame,
  authenticate = async () => true,
  principalKey = defaultPrincipalKey,
  basePath = '/api/previews',
  sessionTtlMs = DEFAULT_TTL_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  now = () => Date.now(),
} = {}) {
  if (typeof resolveAsset !== 'function' || typeof renderFrame !== 'function') {
    throw new TypeError('pt-loader: preview server needs resolveAsset and renderFrame callbacks');
  }
  if (!Number.isInteger(sessionTtlMs) || sessionTtlMs <= 0) {
    throw new RangeError('pt-loader: preview sessionTtlMs must be a positive integer');
  }
  if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
    throw new RangeError('pt-loader: preview maxSessions must be a positive integer');
  }
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new RangeError('pt-loader: preview maxFrameBytes must be a positive integer');
  }

  const prefix = normaliseBasePath(basePath);
  const sessions = new Map();

  return async function previewHandler(request) {
    try {
      const url = new URL(request.url, 'http://pt-preview.invalid');
      const principal = await authenticate(request);
      if (principal === null || principal === false || principal === undefined) {
        return json({ error: 'unauthorized' }, 401);
      }

      const route = routeOf(url.pathname, prefix);
      if (route === 'sessions' && request.method === 'POST') {
        return await openSession(request, principal);
      }

      const match = route.match(/^sessions\/([^/]+)(?:\/(render))?$/);
      if (!match) return json({ error: 'not_found' }, 404);

      const sessionId = decodeURIComponent(match[1]);
      const session = getSession(sessionId, principal);
      if (!session) return json({ error: 'not_found' }, 404);

      if (match[2] === 'render' && request.method === 'POST') {
        return await renderSession(request, session);
      }
      if (!match[2] && request.method === 'DELETE') {
        sessions.delete(sessionId);
        return new Response(null, { status: 204 });
      }
      return json({ error: 'method_not_allowed' }, 405);
    } catch (err) {
      // Never return resolver paths, parser errors or renderer internals to a
      // public preview client. Log the cause in the hosting application.
      const status = Number.isInteger(err?.status) ? err.status : 500;
      const code = status >= 500 ? 'preview_error' : err.code || 'bad_request';
      return json({ error: code }, status);
    }
  };

  async function openSession(request, principal) {
    const body = await readJson(request, MAX_STATE_BYTES);
    if (body?.protocol !== PT_PREVIEW_PROTOCOL) return json({ error: 'protocol_mismatch' }, 400);
    if (!validId(body.assetId)) return json({ error: 'invalid_asset_id' }, 400);
    if (!validKind(body.kind)) return json({ error: 'invalid_kind' }, 400);
    if (!validViewport(body.viewport)) return json({ error: 'invalid_viewport' }, 400);
    if (!plainObject(body.options)) return json({ error: 'invalid_options' }, 400);

    pruneExpired();
    if (sessions.size >= maxSessions) return json({ error: 'capacity' }, 429);

    // The resolver receives only an opaque id. It is responsible for mapping
    // that id to an allow-listed private asset; filesystem paths never come
    // from the client request.
    const asset = await resolveAsset({
      request,
      assetId: body.assetId,
      kind: body.kind,
      viewport: body.viewport,
      options: body.options,
    });
    if (asset === null || asset === undefined || asset === false) {
      return json({ error: 'not_found' }, 404);
    }
    pruneExpired();
    if (sessions.size >= maxSessions) return json({ error: 'capacity' }, 429);

    const sessionId = randomUUID();
    const expiresAt = now() + sessionTtlMs;
    sessions.set(sessionId, {
      sessionId,
      asset,
      assetId: body.assetId,
      kind: body.kind,
      viewport: body.viewport,
      options: body.options,
      principal,
      principalKey: principalKey(principal),
      expiresAt,
    });

    return json({
      protocol: PT_PREVIEW_PROTOCOL,
      sessionId,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  async function renderSession(request, session) {
    const body = await readJson(request, MAX_STATE_BYTES);
    if (body?.protocol !== PT_PREVIEW_PROTOCOL || !plainObject(body.state)) {
      return json({ error: 'invalid_state' }, 400);
    }

    const result = await renderFrame({
      request,
      signal: request.signal,
      asset: session.asset,
      assetId: session.assetId,
      kind: session.kind,
      viewport: session.viewport,
      options: session.options,
      state: body.state,
      principal: session.principal,
    });
    const contentType = String(result?.contentType ?? '')
      .split(';', 1)[0]
      .toLowerCase();
    if (!FRAME_TYPES.has(contentType)) return json({ error: 'invalid_frame_type' }, 500);

    const bytes = await toBytes(result?.body);
    if (bytes.byteLength > maxFrameBytes) return json({ error: 'frame_too_large' }, 413);

    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }

  function getSession(sessionId, principal) {
    if (!validId(sessionId)) return null;
    const session = sessions.get(sessionId);
    if (!session || session.expiresAt <= now()) {
      sessions.delete(sessionId);
      return null;
    }
    return session.principalKey === principalKey(principal) ? session : null;
  }

  function pruneExpired() {
    const time = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= time) sessions.delete(id);
    }
  }
}

function normaliseBasePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new TypeError('pt-loader: preview basePath must be an absolute path');
  }
  return path.replace(/\/+$/, '') || '/';
}

function routeOf(pathname, prefix) {
  if (prefix === '/') return pathname.replace(/^\/+/, '');
  if (pathname === prefix) return '';
  if (!pathname.startsWith(`${prefix}/`)) return '__outside__';
  return pathname.slice(prefix.length + 1);
}

function validId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9._~-]+$/.test(value)
  );
}

function validKind(value) {
  return value === 'model' || value === 'character' || value === 'stage';
}

function validViewport(viewport) {
  return (
    plainObject(viewport) &&
    Number.isInteger(viewport.width) &&
    viewport.width >= 64 &&
    viewport.width <= 4096 &&
    Number.isInteger(viewport.height) &&
    viewport.height >= 64 &&
    viewport.height <= 4096 &&
    Number.isFinite(viewport.pixelRatio) &&
    viewport.pixelRatio > 0 &&
    viewport.pixelRatio <= 4
  );
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(request, maxBytes) {
  let text;
  try {
    text = new TextDecoder().decode(await readResponseBytes(request, maxBytes, 'preview request'));
  } catch (err) {
    if (err instanceof RangeError) throw new PreviewRequestError('request_too_large', 413);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PreviewRequestError('invalid_json', 400);
  }
}

class PreviewRequestError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

async function toBytes(body) {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new Error('preview renderer returned an unsupported body');
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function defaultPrincipalKey(principal) {
  return typeof principal === 'string' ? principal : JSON.stringify(principal);
}
