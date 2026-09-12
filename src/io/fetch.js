/**
 * Run an asset request with static or per-request fetch options.
 *
 * The callback form is useful for short-lived authorization tokens. It is
 * deliberately evaluated immediately before `fetch`, never when the loader is
 * constructed, so refreshed credentials are picked up automatically.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string} url
 * @param {string} path
 * @param {'asset'|'model'|'stage'|'animation'|'texture'|'manifest'|'preview'} kind
 * @param {RequestInit|((context: {url:string, path:string, kind:string}) =>
 *   RequestInit|undefined|Promise<RequestInit|undefined>)|undefined} requestInit
 */
export async function fetchAsset(fetchImpl, url, path, kind, requestInit) {
  const init =
    typeof requestInit === 'function' ? await requestInit({ url, path, kind }) : requestInit;
  return fetchImpl(url, init);
}

/**
 * Read a response while enforcing a hard byte limit before allocating the
 * result. This is intentionally shared by models, textures and manifests so
 * an untrusted endpoint cannot make the loader buffer arbitrary data.
 */
export async function readResponseBytes(response, maxBytes, label = 'asset') {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('pt-loader: max response bytes must be a positive integer');
  }

  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RangeError(`pt-loader: ${label} response exceeds the ${maxBytes}-byte limit`);
  }

  const reader = response?.body?.getReader?.();
  if (reader) {
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new RangeError(`pt-loader: ${label} response exceeds the ${maxBytes}-byte limit`);
        }
        chunks.push(chunk);
      }
    } catch (err) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed.
      }
      throw err;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out.buffer;
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new RangeError(`pt-loader: ${label} response exceeds the ${maxBytes}-byte limit`);
  }
  return buffer;
}

/** Read a bounded text response, preserving the same limit semantics. */
export async function readResponseText(response, maxBytes, label = 'response') {
  const bytes = new Uint8Array(await readResponseBytes(response, maxBytes, label));
  return new TextDecoder().decode(bytes);
}
