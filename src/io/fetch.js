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
