import * as THREE from 'three';
import { decodeImage, NATIVE_EXTENSIONS } from './decode.js';
import { resolveAssetPath, baseOf } from '../util/paths.js';
import { fetchAsset } from '../io/fetch.js';

/**
 * Loads, decrypts, decodes and caches Priston Tale textures.
 *
 * **Orientation contract.** `decodeImage` returns bottom-up RGBA, which is
 * OpenGL's texture layout, so those textures are created with `flipY = false`.
 * Browser-decoded formats (PNG/WebP, produced by `pt-assets textures`) are
 * flipped at decode time so they end up in the same layout. Either way the UV
 * attribute keeps its `1 - v` flip and both paths agree.
 */
export class TextureCache {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl=''] prefix for every request
   * @param {Record<string,string>|Map<string,string>|null} [opts.manifest]
   *   lower-cased logical path -> real path; see `pt-assets manifest`
   * @param {typeof fetch} [opts.fetch] custom fetch (proxies, auth, Node)
   * @param {RequestInit|((context: {url:string, path:string, kind:string}) =>
   *   RequestInit|Promise<RequestInit>)} [opts.requestInit] fetch options,
   *   evaluated per request when supplied as a callback
   * @param {number} [opts.anisotropy=4]
   * @param {number} [opts.maxSize=4096] downscale above this; 0 disables
   * @param {boolean} [opts.warnMissing=true]
   */
  constructor({
    baseUrl = '',
    manifest = null,
    fetch: fetchImpl = undefined,
    requestInit = undefined,
    anisotropy = 4,
    maxSize = 4096,
    warnMissing = true,
  } = {}) {
    this.baseUrl = baseUrl;
    this.manifest = manifest;
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.requestInit = requestInit;
    this.anisotropy = anisotropy;
    this.maxSize = maxSize;
    this.warnMissing = warnMissing;

    /** @type {Map<string, Promise<THREE.Texture>>} */
    this.cache = new Map();
    /** @type {Set<string>} */
    this.missingPaths = new Set();
    this._missing = null;
  }

  /**
   * A 2x2 magenta/black checker used whenever a texture cannot be resolved.
   * Seeing it means the manifest is incomplete — that is the point.
   */
  get missingTexture() {
    if (!this._missing) {
      const d = new Uint8Array([
        255, 0, 255, 255, 20, 20, 20, 255, 20, 20, 20, 255, 255, 0, 255, 255,
      ]);
      const t = new THREE.DataTexture(d, 2, 2, THREE.RGBAFormat);
      t.magFilter = THREE.NearestFilter;
      t.minFilter = THREE.NearestFilter;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;
      t.name = 'pt_missing';
      t.userData.ptHasAlpha = false;
      t.needsUpdate = true;
      this._missing = t;
    }
    return this._missing;
  }

  /**
   * Load one texture. Never rejects: unresolved names resolve to
   * `missingTexture` so a single bad reference cannot fail a whole model.
   *
   * @param {string} folder directory of the owning .smd, with trailing slash
   * @param {string} name texture name as stored in the material
   * @param {{srgb?: boolean}} [opts]
   * @returns {Promise<THREE.Texture>}
   */
  load(folder, name, { srgb = true } = {}) {
    const resolved = resolveAssetPath(folder, name, this.manifest);
    const key = `${resolved ?? `?${folder}${name}`}|${srgb ? 's' : 'l'}`;

    let hit = this.cache.get(key);
    if (hit) return hit;

    const promise = this.#loadUncached(resolved, name, srgb).catch((err) => {
      if (this.warnMissing && !this.missingPaths.has(key)) {
        this.missingPaths.add(key);
        console.warn(
          `[pt-loader] texture "${name}" -> ${resolved ?? '(unresolved)'}: ${err.message}`,
        );
      }
      return this.missingTexture;
    });

    this.cache.set(key, promise);
    promise.then((texture) => {
      // Missing includes 401/403 responses. Let a later request retry after the
      // user logs in or a short-lived token has been refreshed.
      if (texture === this._missing && this.cache.get(key) === promise) this.cache.delete(key);
    });
    return promise;
  }

  async #loadUncached(resolved, name, srgb) {
    if (!resolved) throw new Error('not present in manifest');

    const url = this.baseUrl + resolved;
    const res = await fetchAsset(this.fetch, url, resolved, 'texture', this.requestInit);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();

    const ext = baseOf(resolved).toLowerCase().split('.').pop();
    const texture = NATIVE_EXTENSIONS.has(ext)
      ? await this.#fromNative(buffer, ext)
      : this.#fromRaw(buffer, resolved);

    texture.name = name;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = this.anisotropy;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    return texture;
  }

  /** BMP / TGA: decrypted and decoded in JS, already bottom-up. */
  #fromRaw(buffer, path) {
    let { width, height, data, hasAlpha } = decodeImage(buffer, path);
    if (this.maxSize > 0 && (width > this.maxSize || height > this.maxSize)) {
      ({ width, height, data } = downscaleRGBA(data, width, height, this.maxSize));
    }
    const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
    t.flipY = false; // data is bottom-up already
    t.userData.ptHasAlpha = hasAlpha;
    return t;
  }

  /** PNG / JPEG / WebP: decoded by the browser, flipped to bottom-up. */
  async #fromNative(buffer, ext) {
    const blob = new Blob([buffer], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` });

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY' });
        const t = new THREE.Texture(bitmap);
        t.flipY = false; // the bitmap was flipped during decode
        t.userData.ptHasAlpha = ext === 'png' || ext === 'webp' || ext === 'avif';
        return t;
      } catch {
        // `imageOrientation` is unsupported here; fall through to <img>.
      }
    }

    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('image decode failed'));
        el.src = url;
      });
      const t = new THREE.Texture(img);
      t.flipY = true; // <img> is top-down; three flips it on upload
      t.userData.ptHasAlpha = ext === 'png' || ext === 'webp' || ext === 'avif';
      return t;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Resolve every texture referenced by a material group.
   *
   * @param {{materials: object[]}|null} materialGroup
   * @param {string} folder directory of the owning .smd
   * @returns {Promise<Map<number, {diffuse: THREE.Texture|null,
   *   lightmap: THREE.Texture|null, anim: THREE.Texture[], diffuseHasAlpha: boolean}>>}
   */
  async loadMaterialGroup(materialGroup, folder) {
    const out = new Map();
    if (!materialGroup) return out;

    const jobs = materialGroup.materials.map(async (m, i) => {
      if (m.inUse === 0) {
        out.set(i, { diffuse: null, lightmap: null, anim: [], diffuseHasAlpha: false });
        return;
      }
      const diffuse = m.textures[0] ? await this.load(folder, m.textures[0].name) : null;
      const lightmap = m.textures[1]
        ? await this.load(folder, m.textures[1].name, { srgb: false })
        : null;
      const anim = await Promise.all(m.animTextures.map((t) => this.load(folder, t.name)));

      out.set(i, {
        diffuse,
        lightmap,
        anim,
        diffuseHasAlpha: !!diffuse?.userData?.ptHasAlpha,
      });
    });

    await Promise.all(jobs);
    return out;
  }

  /** Release every GPU resource held by the cache. */
  dispose() {
    for (const p of this.cache.values()) {
      Promise.resolve(p)
        .then((t) => t?.dispose?.())
        .catch(() => {});
    }
    this.cache.clear();
    this._missing?.dispose();
    this._missing = null;
  }
}

/**
 * Box-filter downscale of an RGBA buffer, preserving the bottom-up layout.
 * @param {Uint8Array} src
 */
export function downscaleRGBA(src, width, height, maxSize) {
  const scale = Math.min(maxSize / width, maxSize / height);
  const w = Math.max(1, Math.floor(width * scale));
  const h = Math.max(1, Math.floor(height * scale));
  const dst = new Uint8Array(w * h * 4);

  const sx = width / w;
  const sy = height / h;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));

      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * width + xx) * 4;
          r += src[o];
          g += src[o + 1];
          b += src[o + 2];
          a += src[o + 3];
          n++;
        }
      }
      const d = (y * w + x) * 4;
      dst[d] = r / n;
      dst[d + 1] = g / n;
      dst[d + 2] = b / n;
      dst[d + 3] = a / n;
    }
  }

  return { width: w, height: h, data: dst };
}
