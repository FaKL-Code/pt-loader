import * as THREE from 'three';

import { parsePAT3D, parseSTAGE3D, parseINX } from './core.js';
import { TextureCache } from './textures/TextureCache.js';
import { fetchAsset, readResponseBytes, readResponseText } from './io/fetch.js';
import { buildModel, buildStage, buildCollisionMesh } from './build/model.js';
import { buildClips } from './build/animation.js';
import { pickAt } from './build/picking.js';
export { PTPreviewClient, PTPreviewError, PT_PREVIEW_PROTOCOL } from './preview.js';
import {
  dirOf,
  baseOf,
  changeExt,
  stripExt,
  normalize,
  assertSafeAssetPath,
  isSafeAssetPath,
} from './util/paths.js';

export * from './core.js';
export { TextureCache, downscaleRGBA } from './textures/TextureCache.js';
export {
  buildModel,
  buildStage,
  buildCollisionMesh,
  UP_AXIS_FIX,
  UNIT_SCALE,
} from './build/model.js';
export { buildGeometry, buildCollisionGeometry, computeSmoothNormals } from './build/geometry.js';
export {
  createMaterial,
  createWindAnimator,
  shouldSkipMaterial,
  isCollidable,
  isScrolling,
  scrollSpeedOf,
  windEffectOf,
} from './build/materials.js';
export { buildBones, createSkeleton, mapVertexBones } from './build/skeleton.js';
export {
  pickAt,
  pointerToNDC,
  findMeshesByTexture,
  sampleTextureAlpha,
  PTHighlight,
} from './build/picking.js';
export {
  buildClips,
  buildClip,
  extractBoneTracks,
  frameToSeconds,
  tickToFrame,
} from './build/animation.js';
export { mat4FromFile, invertSafe, bindMatrixOf, inverseBindMatrixOf } from './build/math.js';

/**
 * High-level loader for Priston Tale assets.
 *
 * ```js
 * const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest });
 * scene.add(await loader.loadModel('image/Sinimage/Items/DropItem/it0123.smd'));
 * ```
 *
 * Every `load*` method returns objects that are ready to add to a scene. Call
 * `update(elapsedSeconds)` once per frame to drive scrolling water, flipbook
 * torches and wind sway; skeletal animation is driven by a normal
 * `THREE.AnimationMixer`.
 */
export class PTLoader {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl=''] prefix for every asset request
   * @param {Record<string,string>|Map<string,string>|null} [opts.manifest]
   *   output of `pt-assets manifest`; strongly recommended — without it,
   *   texture lookups are case-sensitive and will break in production
   * @param {typeof fetch} [opts.fetch] custom fetch implementation
   * @param {RequestInit|((context: {url:string, path:string, kind:string}) =>
   *   RequestInit|Promise<RequestInit>)} [opts.requestInit] static or dynamic
   *   fetch options; use this for credentials and authorization headers
   * @param {TextureCache} [opts.textureCache] bring your own cache
   * @param {boolean} [opts.useWorker=false] parse off the main thread
   * @param {number} [opts.maxAssetBytes=67108864] maximum model/map/animation response size
   * @param {number} [opts.maxManifestBytes=4194304] maximum manifest response size
   * @param {number} [opts.maxBufferCacheBytes=67108864] memory retained by parsed input buffers
   * @param {object} [opts.options] defaults for every build; see `buildModel`
   */
  constructor({
    baseUrl = '',
    manifest = null,
    fetch: fetchImpl = undefined,
    requestInit = undefined,
    textureCache = null,
    useWorker = false,
    maxAssetBytes = 64 * 1024 * 1024,
    maxManifestBytes = 4 * 1024 * 1024,
    maxBufferCacheBytes = 64 * 1024 * 1024,
    options = {},
  } = {}) {
    this.baseUrl = baseUrl;
    validateManifest(manifest);
    this.manifest = manifest;
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.requestInit = requestInit;
    this.options = options;
    assertPositiveLimit(maxAssetBytes, 'maxAssetBytes');
    assertPositiveLimit(maxManifestBytes, 'maxManifestBytes');
    assertPositiveLimit(maxBufferCacheBytes, 'maxBufferCacheBytes');
    this.maxAssetBytes = maxAssetBytes;
    this.maxManifestBytes = maxManifestBytes;
    this.maxBufferCacheBytes = maxBufferCacheBytes;
    this.textures =
      textureCache ??
      new TextureCache({
        ...options,
        baseUrl,
        manifest,
        fetch: this.fetch,
        requestInit,
      });
    if (textureCache && requestInit !== undefined) textureCache.requestInit = requestInit;

    this.useWorker = useWorker;
    this._worker = null;
    this._jobs = new Map();
    this._jobId = 0;

    /** Roots whose animated materials `update()` drives. @type {Set<THREE.Object3D>} */
    this.updatables = new Set();
    /** @type {Map<string, {promise: Promise<ArrayBuffer>, bytes: number}>} */
    this._buffers = new Map();
    this._bufferBytes = 0;
  }

  /** Fetch and cache a manifest produced by `pt-assets manifest`. */
  static async loadManifest(
    url,
    fetchImpl = globalThis.fetch,
    requestInit = undefined,
    { maxBytes = 4 * 1024 * 1024 } = {},
  ) {
    const res = await fetchAsset(fetchImpl, url, url, 'manifest', requestInit);
    if (!res.ok) throw new Error(`pt-loader: manifest ${url} -> HTTP ${res.status}`);
    try {
      return JSON.parse(await readResponseText(res, maxBytes, 'manifest'));
    } catch (err) {
      if (err instanceof RangeError) throw err;
      throw new Error(`pt-loader: manifest ${url} is not valid JSON`);
    }
  }

  /** Fetch, install and return a manifest using this loader's auth and limits. */
  async loadManifest(url) {
    const manifest = await PTLoader.loadManifest(url, this.fetch, this.requestInit, {
      maxBytes: this.maxManifestBytes,
    });
    this.setManifest(manifest);
    return manifest;
  }

  /** Swap the manifest at runtime (e.g. after switching texture packs). */
  setManifest(manifest) {
    validateManifest(manifest);
    this.manifest = manifest;
    this.textures.manifest = manifest;
  }

  // ------------------------------------------------------------------ io ---

  /**
   * Fetch an asset as an `ArrayBuffer`, deduplicating concurrent requests.
   * @param {string} path relative to `baseUrl`
   * @param {'asset'|'model'|'stage'|'animation'} [kind='asset'] request kind
   */
  fetchBuffer(path, kind = 'asset') {
    const p = assertSafeAssetPath(normalize(path));
    const hit = this._buffers.get(p);
    if (hit) {
      this._buffers.delete(p);
      this._buffers.set(p, hit);
      return hit.promise;
    }

    const job = (async () => {
      const real = this.#resolve(p);
      const res = await fetchAsset(this.fetch, this.baseUrl + real, real, kind, this.requestInit);
      if (!res.ok) throw new Error(`pt-loader: ${real} -> HTTP ${res.status}`);
      return readResponseBytes(res, this.maxAssetBytes, kind);
    })();

    const entry = { promise: job, bytes: 0 };
    this._buffers.set(p, entry);
    job.catch(() => {
      // A 401/403 may become valid after login or token refresh. Do not poison
      // the cache permanently with a rejected authorization request.
      if (this._buffers.get(p) === entry) this._buffers.delete(p);
    });
    job
      .then((buffer) => {
        if (this._buffers.get(p) !== entry) return;
        entry.bytes = buffer.byteLength;
        this._bufferBytes += entry.bytes;
        this.#trimBufferCache();
      })
      .catch(() => {});
    return job;
  }

  #resolve(path) {
    if (!this.manifest) return path;
    const get =
      this.manifest instanceof Map ? (k) => this.manifest.get(k) : (k) => this.manifest[k];
    return assertSafeAssetPath(get(path.toLowerCase()) ?? path, 'manifest asset path');
  }

  #trimBufferCache() {
    for (const [path, entry] of this._buffers) {
      if (this._bufferBytes <= this.maxBufferCacheBytes) break;
      if (entry.bytes === 0) continue;
      this._buffers.delete(path);
      this._bufferBytes -= entry.bytes;
    }
  }

  // -------------------------------------------------------------- parsing ---

  /** Parse a `.smd` model or a `.smb` skeleton. */
  async parsePAT3D(path) {
    return this.#parse('pat3d', await this.fetchBuffer(path, 'model'));
  }

  /** Parse a `.smd` map. */
  async parseSTAGE3D(path) {
    return this.#parse('stage3d', await this.fetchBuffer(path, 'stage'));
  }

  /** Parse an `.inx` animation index. */
  async parseINX(path) {
    return this.#parse('inx', await this.fetchBuffer(path, 'animation'));
  }

  async #parse(kind, buffer) {
    if (this.useWorker) {
      try {
        return await this.#parseInWorker(kind, buffer);
      } catch (err) {
        console.warn(
          `[pt-loader] worker parse failed, falling back to main thread: ${err.message}`,
        );
        this.useWorker = false;
      }
    }
    const fn = { pat3d: parsePAT3D, stage3d: parseSTAGE3D, inx: parseINX }[kind];
    return fn(buffer);
  }

  #parseInWorker(kind, buffer) {
    if (!this._worker) {
      if (typeof Worker === 'undefined')
        throw new Error('Worker is unavailable in this environment');
      this._worker = new Worker(new URL('./worker/parse.worker.js', import.meta.url), {
        type: 'module',
      });
      this._worker.onmessage = (e) => {
        const { id, result, error } = e.data;
        const job = this._jobs.get(id);
        if (!job) return;
        this._jobs.delete(id);
        if (error) job.reject(new Error(error));
        else {
          if (Array.isArray(result.nameToIndex)) result.nameToIndex = new Map(result.nameToIndex);
          job.resolve(result);
        }
      };
      this._worker.onerror = (e) => {
        for (const job of this._jobs.values()) job.reject(new Error(e.message ?? 'worker error'));
        this._jobs.clear();
      };
    }

    const id = ++this._jobId;
    // The buffer is copied rather than transferred: callers may reuse it, and
    // the parsers never mutate model data.
    return new Promise((resolve, reject) => {
      this._jobs.set(id, { resolve, reject });
      this._worker.postMessage({ id, kind, buffer });
    });
  }

  // -------------------------------------------------------------- loading ---

  /**
   * Load a static model: a drop item, a weapon, a scenery prop.
   *
   * @param {string} path e.g. `image/Sinimage/Items/DropItem/it0123.smd`
   * @param {object} [opts]
   * @param {string} [opts.textureFolder] override where textures are looked up
   * @param {object} [opts.options] per-call build options
   * @returns {Promise<THREE.Group>}
   */
  async loadModel(path, { textureFolder, options } = {}) {
    const smd = changeExt(path, 'smd');
    const pat = await this.parsePAT3D(smd);
    const folder = textureFolder ?? dirOf(smd);
    const textures = await this.textures.loadMaterialGroup(pat.materialGroup, folder);

    const root = buildModel(pat, {
      resolveTextures: (m, i) => textures.get(i) ?? EMPTY_TEX,
      name: stripExt(smd),
      options: { ...this.options, ...options },
    });
    root.userData.ptSource = smd;
    this.updatables.add(root);
    return root;
  }

  /**
   * Load an animated character: player, NPC or monster.
   *
   * Accepts an `.inx` path, or a `.ini`/`.in` path whose extension is swapped
   * for `.inx` (the game's text scripts are compiled into that binary index).
   *
   * @param {string} path
   * @param {object} [opts]
   * @param {object} [opts.options]
   * @returns {Promise<{
   *   object: THREE.Group,
   *   clips: Record<string, THREE.AnimationClip>,
   *   clipNames: string[],
   *   reversed: Set<string>,
   *   byState: Record<number, string>,
   *   inx: object|null,
   *   skeleton: THREE.Skeleton|null,
   *   createMixer: () => THREE.AnimationMixer,
   *   play: (name: string, mixer?: THREE.AnimationMixer) => THREE.AnimationAction|null
   * }>}
   */
  async loadCharacter(path, { options } = {}) {
    const folder = dirOf(path);
    let inx = null;

    try {
      inx = await this.parseINX(changeExt(path, 'inx'));
    } catch (err) {
      console.warn(`[pt-loader] no .inx for "${path}" (${err.message}); loading mesh only`);
    }

    // A model with no animation of its own borrows another model's motion file.
    if (inx?.motionLinkFile) {
      try {
        const linked = await this.parseINX(folder + baseOf(changeExt(inx.motionLinkFile, 'inx')));
        if (linked.motionFile) inx = { ...inx, motionFile: linked.motionFile };
      } catch (err) {
        console.warn(
          `[pt-loader] motionLinkFile "${inx.motionLinkFile}" unavailable: ${err.message}`,
        );
      }
    }

    const smdName = inx?.modelFile
      ? baseOf(changeExt(inx.modelFile, 'smd'))
      : `${stripExt(path)}.smd`;
    const smdPath = folder + smdName;

    let skeletonPat = null;
    const smbSource = inx?.motionFile || inx?.modelFile || path;
    const smbPath = folder + baseOf(changeExt(smbSource, 'smb'));
    try {
      skeletonPat = await this.parsePAT3D(smbPath);
    } catch (err) {
      console.warn(`[pt-loader] no skeleton at "${smbPath}" (${err.message}); rendering unskinned`);
    }

    const pat = await this.parsePAT3D(smdPath);
    const textures = await this.textures.loadMaterialGroup(pat.materialGroup, dirOf(smdPath));

    const object = buildModel(pat, {
      resolveTextures: (m, i) => textures.get(i) ?? EMPTY_TEX,
      skeletonPat,
      name: stripExt(smdPath),
      options: { ...this.options, ...options },
    });
    object.userData.ptSource = smdPath;
    this.updatables.add(object);

    const { clips, reversed, byState } = skeletonPat
      ? buildClips(skeletonPat, inx)
      : { clips: {}, reversed: new Set(), byState: {} };

    const result = {
      object,
      clips,
      clipNames: Object.keys(clips),
      reversed,
      byState,
      inx,
      skeleton: object.userData.ptSkeleton ?? null,
      createMixer: () => new THREE.AnimationMixer(object),
      play(name, mixer) {
        const clip = clips[name];
        if (!clip) return null;
        const mx = mixer ?? (result._mixer ??= new THREE.AnimationMixer(object));
        const action = mx.clipAction(clip);
        if (reversed.has(name)) {
          action.timeScale = -1;
          action.time = clip.duration;
        }
        action.reset().play();
        return action;
      },
    };
    return result;
  }

  /**
   * Load a map (STAGE3D).
   * @param {string} path e.g. `field/forest/forest.smd`
   * @param {object} [opts]
   * @param {string} [opts.textureFolder] swap the texture pack without touching the map
   * @param {object} [opts.options]
   * @returns {Promise<THREE.Group>}
   */
  async loadStage(path, { textureFolder, options } = {}) {
    const smd = changeExt(path, 'smd');
    const stage = await this.parseSTAGE3D(smd);
    const folder = textureFolder ?? dirOf(smd);
    const textures = await this.textures.loadMaterialGroup(stage.materialGroup, folder);

    const root = buildStage(stage, {
      resolveTextures: (m, i) => textures.get(i) ?? EMPTY_TEX,
      name: stripExt(smd),
      options: { ...this.options, ...options },
    });
    root.userData.ptSource = smd;
    this.updatables.add(root);
    return root;
  }

  /**
   * Load an invisible collision mesh for raycasting or physics.
   * @param {string} path a map or model path
   * @param {{kind?: 'stage'|'model'}} [opts]
   * @returns {Promise<THREE.Mesh|null>}
   */
  async loadCollision(path, { kind = 'stage' } = {}) {
    const smd = changeExt(path, 'smd');
    const parsed = kind === 'stage' ? await this.parseSTAGE3D(smd) : await this.parsePAT3D(smd);
    return buildCollisionMesh(parsed);
  }

  // ---------------------------------------------------------------- picking ---

  /**
   * Raycast into a loaded object and describe the surface that was hit,
   * including which texture it uses and every other surface sharing it.
   *
   * A convenience wrapper around the standalone `pickAt`. Use it when you drive
   * your own camera and input; `PTViewer.onPick` wires this up for you.
   *
   * ```js
   * const result = loader.pick(model, camera, pointerToNDC(event, canvas));
   * if (result) console.log(result.textureName, result.siblings.length);
   * ```
   *
   * @param {THREE.Object3D} root object returned by a `load*` call
   * @param {THREE.Camera} camera
   * @param {THREE.Vector2|{x:number,y:number}} pointer normalised device coordinates
   * @param {object} [opts] see `pickAt`
   * @returns {import('./build/picking.js').PTPickResult|null}
   */
  pick(root, camera, pointer, opts = {}) {
    return pickAt({ root, camera, pointer, ...opts });
  }

  // ------------------------------------------------------------- lifecycle ---

  /**
   * Drive every animated material and wind sway loaded through this loader.
   * Call once per frame with the elapsed time in seconds.
   * @param {number} elapsedSeconds
   */
  update(elapsedSeconds) {
    for (const root of this.updatables) root.userData.ptUpdate?.(elapsedSeconds);
  }

  /** Stop updating a root and release its geometries and materials. */
  release(root) {
    this.updatables.delete(root);
    root.traverse((o) => {
      o.geometry?.dispose?.();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
      else m?.dispose?.();
    });
  }

  /** Release everything: textures, buffers, worker. */
  dispose() {
    for (const root of [...this.updatables]) this.release(root);
    this.updatables.clear();
    this.textures.dispose();
    this._buffers.clear();
    this._bufferBytes = 0;
    for (const job of this._jobs.values()) job.reject(new Error('pt-loader: loader disposed'));
    this._jobs.clear();
    this._worker?.terminate();
    this._worker = null;
  }
}

function assertPositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`pt-loader: ${name} must be a positive integer`);
  }
}

function validateManifest(manifest) {
  if (manifest === null || manifest === undefined) return;
  const entries = manifest instanceof Map ? manifest.values() : Object.values(manifest);
  if (!(manifest instanceof Map) && (typeof manifest !== 'object' || Array.isArray(manifest))) {
    throw new TypeError('pt-loader: manifest must be an object, Map or null');
  }
  for (const value of entries) {
    if (typeof value !== 'string' || !isSafeAssetPath(value)) {
      throw new TypeError('pt-loader: manifest contains an unsafe asset path');
    }
  }
}

const EMPTY_TEX = { diffuse: null, lightmap: null, anim: [], diffuseHasAlpha: false };

export default PTLoader;
