/**
 * Protocol client for server-rendered previews.
 *
 * This is intentionally separate from `PTLoader`: the normal loader keeps
 * rendering in the browser, while this contract lets a server keep the
 * original assets private and return only rendered image frames.
 */

export const PT_PREVIEW_PROTOCOL = 'pt-preview-v1';

const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_STATE_BYTES = 64 * 1024;
const FRAME_TYPES = new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp']);

/**
 * Error raised when a preview endpoint violates the protocol or rejects a
 * request. The response body is deliberately not copied into the error, so a
 * backend cannot accidentally expose asset data through client-side logs.
 */
export class PTPreviewError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, operation?: string}} [details]
   */
  constructor(message, { code = 'preview_error', status = 0, operation = '' } = {}) {
    super(message);
    this.name = 'PTPreviewError';
    this.code = code;
    this.status = status;
    this.operation = operation;
  }
}

/**
 * Client for the `pt-preview-v1` server contract.
 *
 * The server owns the original model and texture files. The client sends an
 * opaque asset id and camera state, and accepts only image/* responses from
 * the render endpoint. It never receives a model, texture, manifest or asset
 * URL.
 */
export class PTPreviewClient {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint base URL for the preview API
   * @param {typeof fetch} [opts.fetch] custom fetch implementation
   * @param {RequestInit|Function} [opts.requestInit]
   * @param {number} [opts.maxFrameBytes=8388608] maximum accepted frame size
   */
  constructor({
    endpoint,
    fetch: fetchImpl = undefined,
    requestInit = undefined,
    maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  } = {}) {
    if (typeof endpoint !== 'string' || endpoint.trim() === '') {
      throw new TypeError('pt-loader: preview endpoint is required');
    }
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
      throw new RangeError('pt-loader: preview maxFrameBytes must be a positive integer');
    }

    this.endpoint = endpoint.replace(/\/+$/, '');
    this.fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.requestInit = requestInit;
    this.maxFrameBytes = maxFrameBytes;
    this.session = null;
    this.frame = null;
  }

  /**
   * Create a server-side render session for an opaque asset id.
   *
   * @param {string} assetId id understood by the server; never a filesystem path
   * @param {object} [opts]
   * @param {'model'|'character'|'stage'} [opts.kind='model']
   * @param {number} [opts.width=640]
   * @param {number} [opts.height=480]
   * @param {number} [opts.pixelRatio=1]
   * @param {Record<string, unknown>} [opts.options] server-side render options
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<{sessionId: string, expiresAt: string|null}>}
   */
  async open(
    assetId,
    { kind = 'model', width = 640, height = 480, pixelRatio = 1, options = {}, signal } = {},
  ) {
    assertOpaqueId(assetId, 'assetId');
    assertKind(kind);
    assertViewport(width, height, pixelRatio);
    assertJsonObject(options, 'options');

    if (this.session) await this.close();

    const res = await this.#request(`${this.endpoint}/sessions`, 'preview/sessions', {
      method: 'POST',
      signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocol: PT_PREVIEW_PROTOCOL,
        assetId,
        kind,
        viewport: { width, height, pixelRatio },
        options,
      }),
    });
    const body = await readJson(res, 'open');
    if (body?.protocol !== PT_PREVIEW_PROTOCOL) {
      throw new PTPreviewError('pt-loader: preview protocol mismatch', {
        code: 'protocol_mismatch',
        operation: 'open',
      });
    }
    assertOpaqueId(body?.sessionId, 'sessionId');

    this.session = {
      sessionId: body.sessionId,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
    };
    return { ...this.session };
  }

  /**
   * Render one frame from the current session.
   *
   * `state` is intentionally opaque to the client so a server can choose an
   * orbit camera, a full camera matrix, animation controls, or another small
   * control model. The server must validate it and must return image/* only.
   *
   * @param {Record<string, unknown>} [state]
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<{blob: Blob, url: string|null, contentType: string}>}
   */
  async render(state = {}, { signal } = {}) {
    const session = this.#requireSession();
    assertJsonObject(state, 'state');
    const encoded = JSON.stringify({ protocol: PT_PREVIEW_PROTOCOL, state });
    if (encoded.length > MAX_STATE_BYTES) {
      throw new PTPreviewError('pt-loader: preview state is too large', {
        code: 'state_too_large',
        operation: 'render',
      });
    }

    const res = await this.#request(
      `${this.endpoint}/sessions/${encodeURIComponent(session.sessionId)}/render`,
      `preview/sessions/${session.sessionId}/render`,
      {
        method: 'POST',
        signal,
        headers: { Accept: 'image/*', 'Content-Type': 'application/json' },
        body: encoded,
      },
    );
    if (!res.ok) throw responseError(res, 'render');

    const contentType = getHeader(res, 'content-type').split(';', 1)[0].trim().toLowerCase();
    if (!FRAME_TYPES.has(contentType)) {
      throw new PTPreviewError('pt-loader: preview render did not return an image', {
        code: 'invalid_frame_type',
        status: res.status ?? 0,
        operation: 'render',
      });
    }

    const declaredLength = Number(getHeader(res, 'content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxFrameBytes) {
      throw new PTPreviewError('pt-loader: preview frame exceeds maxFrameBytes', {
        code: 'frame_too_large',
        status: res.status ?? 0,
        operation: 'render',
      });
    }

    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > this.maxFrameBytes) {
      throw new PTPreviewError('pt-loader: preview frame exceeds maxFrameBytes', {
        code: 'frame_too_large',
        status: res.status ?? 0,
        operation: 'render',
      });
    }

    this.#releaseFrameUrl();
    const blob = new Blob([bytes], { type: contentType });
    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
    this.frame = { blob, url, contentType };
    return this.frame;
  }

  /** Close the current server-side session. Safe to call more than once. */
  async close({ signal } = {}) {
    const session = this.session;
    this.session = null;
    this.#releaseFrameUrl();
    if (!session) return;

    const res = await this.#request(
      `${this.endpoint}/sessions/${encodeURIComponent(session.sessionId)}`,
      `preview/sessions/${session.sessionId}`,
      { method: 'DELETE', signal, headers: { Accept: 'application/json' } },
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw responseError(res, 'close');
    }
  }

  /** Release the local frame URL without making a network request. */
  dispose() {
    this.session = null;
    this.#releaseFrameUrl();
  }

  #requireSession() {
    if (!this.session) {
      throw new PTPreviewError('pt-loader: preview session is not open', {
        code: 'session_required',
        operation: 'render',
      });
    }
    return this.session;
  }

  async #request(url, path, init) {
    const auth =
      typeof this.requestInit === 'function'
        ? await this.requestInit({ url, path, kind: 'preview' })
        : this.requestInit;
    const merged = { ...(auth ?? {}), ...init };
    merged.headers = mergeHeaders(auth?.headers, init.headers);
    const res = await this.fetch(url, merged);
    if (!res?.ok && init.method !== 'DELETE') throw responseError(res, init.method ?? 'request');
    return res;
  }

  #releaseFrameUrl() {
    if (this.frame?.url && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(this.frame.url);
    }
    this.frame = null;
  }
}

const DEFAULT_PREVIEW_CAMERA = Object.freeze({
  azimuth: 0,
  elevation: 0.2,
  distance: 3.5,
  panX: 0,
  panY: 0,
});

/**
 * Interactive image surface for a {@link PTPreviewClient}.
 *
 * This keeps all browser interaction in the package: the consumer supplies an
 * image element and a preview client, while the original model and textures
 * remain on the server. Pointer capture, native image dragging and render
 * coalescing are handled here so slow server frames do not make the controls
 * intermittent.
 */
export class PTPreviewViewer {
  /**
   * @param {HTMLElement|string} target image element or selector
   * @param {object} options
   * @param {PTPreviewClient} options.client preview client used for frames
   * @param {Partial<typeof DEFAULT_PREVIEW_CAMERA>} [options.camera]
   * @param {object} [options.transform] root position, rotation and scale sent to the server
   * @param {(camera: Record<string, number>, transform: object) => Record<string, unknown>} [options.state]
   * @param {(error: unknown) => void} [options.onError]
   */
  constructor(
    target,
    {
      client,
      camera = {},
      transform = {},
      state = (nextCamera, nextTransform) => ({
        camera: { ...nextCamera },
        transform: clonePreviewTransform(nextTransform),
      }),
      onError = undefined,
    } = {},
  ) {
    const element = resolvePreviewElement(target);
    if (!element) throw new TypeError('pt-loader: preview target element is required');
    if (!client || typeof client.render !== 'function' || typeof client.open !== 'function') {
      throw new TypeError('pt-loader: preview viewer requires a PTPreviewClient');
    }
    if (typeof state !== 'function')
      throw new TypeError('pt-loader: preview state must be a function');

    this.element = element;
    this.client = client;
    this.camera = { ...DEFAULT_PREVIEW_CAMERA, ...camera };
    this.transform = clonePreviewTransform(transform);
    this.state = state;
    this.onError = onError;
    this._disposed = false;
    this._generation = 0;
    this._queued = false;
    this._drainPromise = null;
    this._drainResolve = null;
    this._drainReject = null;
    this._ownedUrl = null;
    this._bindControls();
  }

  /** Open a server session and render its first frame. */
  async open(assetId, options = {}) {
    this.#assertActive();
    const generation = ++this._generation;
    await this.client.open(assetId, options);
    if (generation !== this._generation || this._disposed) return null;
    return this.requestRender();
  }

  /** Update camera values and request the newest frame. */
  setCamera(values, { render = true } = {}) {
    this.#assertActive();
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new TypeError('pt-loader: preview camera must be an object');
    }
    Object.assign(this.camera, values);
    return render ? this.requestRender() : Promise.resolve(null);
  }

  /** Update the root transform sent to the private renderer. */
  setTransform(values, { render = true } = {}) {
    this.#assertActive();
    this.transform = clonePreviewTransform(values);
    return render ? this.requestRender() : Promise.resolve(null);
  }

  /** Restore the default orbit camera. */
  resetCamera({ render = true } = {}) {
    return this.setCamera(DEFAULT_PREVIEW_CAMERA, { render });
  }

  /** Render immediately, without changing the camera. */
  async render({ signal } = {}) {
    this.#assertActive();
    const generation = this._generation;
    const frame = await this.client.render(
      this.state({ ...this.camera }, clonePreviewTransform(this.transform)),
      { signal },
    );
    if (generation !== this._generation || this._disposed) return frame;
    this.#setFrame(frame);
    return frame;
  }

  /**
   * Queue a frame. Multiple pointer events collapse into one latest-state
   * request while a server render is in flight.
   */
  requestRender() {
    this.#assertActive();
    this._queued = true;
    if (!this._drainPromise) {
      this._drainPromise = new Promise((resolve, reject) => {
        this._drainResolve = resolve;
        this._drainReject = reject;
      });
      scheduleFrame(() => void this.#drain());
    }
    return this._drainPromise;
  }

  /** Remove event listeners, release the image URL and close local state. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._generation += 1;
    this._queued = false;
    this._unbindControls?.();
    if (this._ownedUrl && typeof URL.revokeObjectURL === 'function')
      URL.revokeObjectURL(this._ownedUrl);
    this._ownedUrl = null;
    this.client.dispose?.();
    const reject = this._drainReject;
    this._drainPromise = null;
    this._drainResolve = null;
    this._drainReject = null;
    reject?.(new PTPreviewError('pt-loader: preview viewer disposed', { code: 'disposed' }));
  }

  #assertActive() {
    if (this._disposed)
      throw new PTPreviewError('pt-loader: preview viewer is disposed', { code: 'disposed' });
  }

  async #drain() {
    let lastFrame = null;
    try {
      while (this._queued && !this._disposed) {
        this._queued = false;
        lastFrame = await this.render();
        if (this._queued) await nextFrame();
      }
      this._drainResolve?.(lastFrame);
    } catch (error) {
      this.onError?.(error);
      this._drainReject?.(error);
    } finally {
      this._drainPromise = null;
      this._drainResolve = null;
      this._drainReject = null;
      if (this._queued && !this._disposed) this.requestRender();
    }
  }

  #setFrame(frame) {
    if (!frame || typeof frame !== 'object')
      throw new PTPreviewError('pt-loader: preview frame is invalid');
    if (this._ownedUrl && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(this._ownedUrl);
      this._ownedUrl = null;
    }
    let url = frame.url;
    if (frame.blob && typeof URL.createObjectURL === 'function') {
      url = URL.createObjectURL(frame.blob);
      this._ownedUrl = url;
    }
    if (typeof url === 'string') this.element.src = url;
  }

  _bindControls() {
    const image = this.element;
    image.draggable = false;
    image.style.touchAction = 'none';
    image.style.userSelect = 'none';
    image.style.webkitUserDrag = 'none';

    const interaction = { pointerId: null, startX: 0, startY: 0, initial: null, pan: false };
    const stop = (event) => {
      if (interaction.pointerId !== event.pointerId) return;
      if (image.hasPointerCapture?.(event.pointerId)) image.releasePointerCapture(event.pointerId);
      interaction.pointerId = null;
      interaction.initial = null;
    };
    const onDown = (event) => {
      if (event.pointerType === 'mouse' && ![0, 1, 2].includes(event.button)) return;
      event.preventDefault();
      interaction.pointerId = event.pointerId;
      interaction.startX = event.clientX;
      interaction.startY = event.clientY;
      interaction.initial = { ...this.camera };
      interaction.pan = event.button === 1 || event.button === 2 || event.shiftKey;
      image.setPointerCapture?.(event.pointerId);
    };
    const onMove = (event) => {
      if (interaction.pointerId !== event.pointerId || !interaction.initial) return;
      event.preventDefault();
      const dx = event.clientX - interaction.startX;
      const dy = event.clientY - interaction.startY;
      if (interaction.pan) {
        this.camera.panX = interaction.initial.panX + dx / 380;
        this.camera.panY = interaction.initial.panY - dy / 380;
      } else {
        this.camera.azimuth = interaction.initial.azimuth + dx / 120;
        this.camera.elevation = Math.max(
          -1.1,
          Math.min(1.1, interaction.initial.elevation - dy / 160),
        );
      }
      void this.requestRender().catch(() => {});
    };
    const onWheel = (event) => {
      event.preventDefault();
      this.camera.distance = Math.max(
        1.8,
        Math.min(8, this.camera.distance * Math.exp(event.deltaY * 0.001)),
      );
      void this.requestRender().catch(() => {});
    };
    const onContextMenu = (event) => event.preventDefault();
    const onDragStart = (event) => event.preventDefault();

    image.addEventListener('pointerdown', onDown, { passive: false });
    image.addEventListener('pointermove', onMove, { passive: false });
    image.addEventListener('pointerup', stop);
    image.addEventListener('pointercancel', stop);
    image.addEventListener('lostpointercapture', stop);
    image.addEventListener('wheel', onWheel, { passive: false });
    image.addEventListener('contextmenu', onContextMenu);
    image.addEventListener('dragstart', onDragStart);
    this._unbindControls = () => {
      image.removeEventListener('pointerdown', onDown);
      image.removeEventListener('pointermove', onMove);
      image.removeEventListener('pointerup', stop);
      image.removeEventListener('pointercancel', stop);
      image.removeEventListener('lostpointercapture', stop);
      image.removeEventListener('wheel', onWheel);
      image.removeEventListener('contextmenu', onContextMenu);
      image.removeEventListener('dragstart', onDragStart);
    };
  }
}

function clonePreviewTransform(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('pt-loader: preview transform must be an object');
  }
  const out = {};
  for (const key of ['position', 'rotation', 'scale']) {
    if (value[key] === undefined) continue;
    const input = value[key];
    const values =
      typeof input === 'number'
        ? [input, input, input]
        : Array.isArray(input)
          ? input
          : [input?.x, input?.y, input?.z];
    if (
      values.length !== 3 ||
      !values.every((item) => Number.isFinite(Number(item))) ||
      (key === 'scale' && values.some((item) => Number(item) <= 0))
    ) {
      throw new TypeError(`pt-loader: preview transform ${key} must contain three finite numbers`);
    }
    out[key] = values.map(Number);
  }
  return out;
}

function resolvePreviewElement(target) {
  if (typeof target === 'string') return globalThis.document?.querySelector(target) ?? null;
  return target && typeof target.addEventListener === 'function' ? target : null;
}

function scheduleFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === 'function')
    globalThis.requestAnimationFrame(callback);
  else globalThis.setTimeout(callback, 0);
}

function nextFrame() {
  return new Promise((resolve) => scheduleFrame(resolve));
}

function assertKind(kind) {
  if (kind !== 'model' && kind !== 'character' && kind !== 'stage') {
    throw new TypeError(`pt-loader: unsupported preview kind "${kind}"`);
  }
}

function assertOpaqueId(value, name) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    value === '.' ||
    value === '..' ||
    !/^[A-Za-z0-9._~-]+$/.test(value)
  ) {
    throw new TypeError(`pt-loader: ${name} must be an opaque id, not a path`);
  }
}

function assertViewport(width, height, pixelRatio) {
  if (
    !Number.isInteger(width) ||
    width < 64 ||
    width > 4096 ||
    !Number.isInteger(height) ||
    height < 64 ||
    height > 4096 ||
    !Number.isFinite(pixelRatio) ||
    pixelRatio <= 0 ||
    pixelRatio > 4
  ) {
    throw new RangeError('pt-loader: preview viewport is outside the supported range');
  }
}

function assertJsonObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`pt-loader: preview ${name} must be an object`);
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new TypeError(`pt-loader: preview ${name} must be JSON-serializable`);
  }
}

function mergeHeaders(a, b) {
  const out = new Headers(a ?? undefined);
  for (const [key, value] of new Headers(b ?? undefined)) out.set(key, value);
  return out;
}

async function readJson(res, operation) {
  if (!res?.ok) throw responseError(res, operation);
  try {
    return typeof res.json === 'function' ? await res.json() : JSON.parse(await res.text());
  } catch {
    throw new PTPreviewError('pt-loader: preview endpoint returned invalid JSON', {
      code: 'invalid_json',
      status: res.status ?? 0,
      operation,
    });
  }
}

function responseError(res, operation) {
  return new PTPreviewError(`pt-loader: preview ${operation} failed`, {
    code: 'http_error',
    status: res?.status ?? 0,
    operation,
  });
}

function getHeader(res, name) {
  if (typeof res?.headers?.get === 'function') return res.headers.get(name) ?? '';
  const value = res?.headers?.[name] ?? res?.headers?.[name.toLowerCase()];
  return value == null ? '' : String(value);
}
