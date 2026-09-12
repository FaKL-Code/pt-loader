/** Normalise Windows separators and collapse duplicate slashes. */
export function normalize(path) {
  return String(path)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
}

/** `"a/b/c.smd"` -> `"a/b/"`. Returns `""` when there is no directory part. */
export function dirOf(path) {
  const p = normalize(path);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i + 1);
}

/** `"a/b/c.smd"` -> `"c.smd"`. */
export function baseOf(path) {
  const p = normalize(path);
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** `"a/b/c.smd"` -> `"c"`. Cuts at the first dot of the basename. */
export function stripExt(path) {
  const b = baseOf(path);
  const i = b.indexOf('.');
  return i < 0 ? b : b.slice(0, i);
}

/** `changeExt("a/b/c.ase", "smd")` -> `"a/b/c.smd"`. */
export function changeExt(path, ext) {
  const p = normalize(path);
  const i = p.lastIndexOf('.');
  return (i < 0 ? p + '.' : p.slice(0, i + 1)) + ext;
}

/**
 * Resolve an asset reference against a manifest.
 *
 * Texture names inside .smd files are bare basenames (`"rock02.bmp"`) and the
 * original assets mix `.BMP`, `.Bmp` and `.bmp` freely, because Windows does
 * not care. An HTTP server does. The manifest maps a lower-cased logical path
 * to the real on-disk path.
 *
 * Lookup order:
 *   1. `folder + name`, lower-cased, in the manifest
 *   2. bare `name`, lower-cased, in the manifest (assets moved between folders)
 *   3. `folder + name` verbatim, as a last resort
 *
 * @param {string} folder directory of the owning .smd, with trailing slash
 * @param {string} name texture name as stored in the material
 * @param {Record<string,string>|Map<string,string>|null} manifest
 * @returns {string|null} path relative to `baseUrl`, or null when unresolved
 */
export function resolveAssetPath(folder, name, manifest) {
  if (!name) return null;
  const bare = baseOf(name);
  const joined = normalize(folder + bare);

  if (manifest) {
    const get = manifest instanceof Map ? (k) => manifest.get(k) : (k) => manifest[k];
    const a = get(joined.toLowerCase());
    if (a) return a;
    const b = get(bare.toLowerCase());
    if (b) return b;
    return null;
  }

  return joined;
}
