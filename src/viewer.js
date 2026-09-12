import * as THREE from 'three';
import { PTLoader } from './index.js';
import { pickAt, pointerToNDC, PTHighlight } from './build/picking.js';

/**
 * A batteries-included viewer: renderer, camera, lights, orbit controls, resize
 * handling and an animation loop, in one object.
 *
 * Use it when the page only needs to show a model and you would rather not
 * assemble a three.js scene by hand. Orbit controls are implemented inline so
 * the package pulls in nothing beyond `three` itself.
 *
 * ```js
 * const viewer = new PTViewer('#item', { baseUrl: '/pt-assets/', manifest });
 * await viewer.show('image/Sinimage/Items/DropItem/it0123.smd');
 * ```
 */
export class PTViewer {
  /**
   * @param {HTMLElement|string} target element or CSS selector to render into
   * @param {object} [opts]
   * @param {string} [opts.baseUrl='']
   * @param {Record<string,string>|null} [opts.manifest]
   * @param {typeof fetch} [opts.fetch] custom fetch implementation
   * @param {RequestInit|Function} [opts.requestInit] authorization options for
   *   every model and texture request
   * @param {PTLoader} [opts.loader] reuse an existing loader
   * @param {number|string|null} [opts.background=null] null keeps it transparent
   * @param {boolean} [opts.autoRotate=false]
   * @param {number} [opts.autoRotateSpeed=0.5] radians per second
   * @param {boolean} [opts.grid=false] show a reference grid
   * @param {number} [opts.fov=45]
   * @param {number} [opts.exposure=1]
   * @param {object} [opts.options] build options forwarded to the loader
   */
  constructor(
    target,
    {
      baseUrl = '',
      manifest = null,
      fetch: fetchImpl = undefined,
      requestInit = undefined,
      loader = null,
      background = null,
      autoRotate = false,
      autoRotateSpeed = 0.5,
      grid = false,
      fov = 45,
      exposure = 1,
      options = {},
      highlight = {},
    } = {},
  ) {
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error(`pt-loader: PTViewer target "${target}" not found`);
    this.container = el;

    this.loader =
      loader ?? new PTLoader({ baseUrl, manifest, fetch: fetchImpl, requestInit, options });
    this.autoRotate = autoRotate;
    this.autoRotateSpeed = autoRotateSpeed;

    // ---- renderer ----
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: background === null });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMappingExposure = exposure;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.touchAction = 'none';
    el.appendChild(this.renderer.domElement);

    // ---- scene ----
    this.scene = new THREE.Scene();
    if (background !== null) this.scene.background = new THREE.Color(background);
    this.scene.add(new THREE.AmbientLight(0xffffff, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, 2, 1.5);
    this.scene.add(key);

    if (grid) {
      this.grid = new THREE.GridHelper(100, 20, 0x888888, 0x444444);
      this.grid.material.opacity = 0.35;
      this.grid.material.transparent = true;
      this.scene.add(this.grid);
    }

    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 20000);
    this.camera.position.set(0, 0, 10);

    // ---- orbit state ----
    this.target = new THREE.Vector3();
    this._spherical = new THREE.Spherical(10, Math.PI / 2.4, Math.PI / 4);
    this._minDistance = 0.1;
    this._maxDistance = 10000;
    this.enabled = true;

    this.current = null;
    this.mixer = null;
    this.action = null;

    /** @type {PTHighlight|null} created on first use */
    this.highlight = null;
    this._highlightOptions = highlight;
    this._pickSubs = new Set();

    this._clock = new THREE.Clock();
    this._raf = null;
    this._disposed = false;

    this.#bindControls();
    this.#bindResize();
    this.#resize();
    this.#updateCamera();
    this.#loop();
  }

  // ------------------------------------------------------------- loading ---

  /**
   * Load and display an asset, replacing whatever is currently shown.
   *
   * @param {string} path
   * @param {object} [opts]
   * @param {'model'|'character'|'stage'} [opts.kind='model']
   * @param {string} [opts.clip] clip to play for a character; defaults to the
   *   first of Idle / Walk / Full that exists
   * @param {boolean} [opts.frame=true] fit the camera to the loaded object
   * @returns {Promise<THREE.Object3D>}
   */
  async show(path, { kind = 'model', clip, frame = true, ...rest } = {}) {
    this.clear();

    let object;
    if (kind === 'character') {
      const character = await this.loader.loadCharacter(path, rest);
      object = character.object;
      this.character = character;
      this.mixer = character.createMixer();

      const pick =
        clip ?? ['Idle', 'Walk', 'Full'].find((n) => character.clips[n]) ?? character.clipNames[0];
      if (pick) this.action = character.play(pick, this.mixer);
    } else if (kind === 'stage') {
      object = await this.loader.loadStage(path, rest);
    } else {
      object = await this.loader.loadModel(path, rest);
    }

    this.current = object;
    this.scene.add(object);
    if (frame) this.frameObject(object);
    return object;
  }

  /** Switch the playing clip. Only meaningful after `show(..., {kind:'character'})`. */
  play(name, { fade = 0.2 } = {}) {
    if (!this.character || !this.mixer) return null;
    const next = this.character.play(name, this.mixer);
    if (next && this.action && this.action !== next) {
      this.action.fadeOut(fade);
      next.reset().fadeIn(fade).play();
    }
    this.action = next;
    return next;
  }

  /** Names of the clips available on the current character. */
  get clipNames() {
    return this.character?.clipNames ?? [];
  }

  // ------------------------------------------------------------- picking ---

  /**
   * Raycast into the displayed object and describe the surface under a pointer.
   *
   * @param {PointerEvent|MouseEvent|{x:number,y:number}} source a DOM event, or
   *   normalised device coordinates
   * @param {object} [opts] forwarded to `pickAt`
   * @returns {import('./build/picking.js').PTPickResult|null}
   */
  pick(source, opts = {}) {
    if (!this.current) return null;
    const pointer =
      typeof source?.clientX === 'number' ? pointerToNDC(source, this.renderer.domElement) : source;
    return pickAt({ root: this.current, camera: this.camera, pointer, ...opts });
  }

  /**
   * Call `callback` whenever the user picks a surface, and outline it.
   *
   * The selected surface is outlined in one colour and every other surface
   * using the same texture in another — the texture-picker behaviour of the
   * original FieldBox tool. Clicking empty space clears the selection and
   * invokes the callback with `null`.
   *
   * Drags are not clicks: a pointer that moves more than `dragThreshold`
   * pixels between press and release orbits the camera instead of picking.
   *
   * ```js
   * const off = viewer.onPick((hit) => {
   *   info.textContent = hit ? `${hit.textureName} (+${hit.siblings.length})` : '';
   * });
   * ```
   *
   * @param {(result: import('./build/picking.js').PTPickResult|null) => void} callback
   * @param {object} [opts]
   * @param {'click'|'pointermove'} [opts.event='click']
   * @param {boolean} [opts.highlight=true] draw the wireframe overlay
   * @param {boolean} [opts.siblings=true] also find surfaces sharing the texture
   * @param {boolean} [opts.matchAllSlots=false] widen the sibling match
   * @param {boolean} [opts.alphaTest=true] click through transparent texels
   * @param {number} [opts.dragThreshold=4] pixels of movement that make it a drag
   * @returns {() => void} unsubscribe
   */
  onPick(
    callback,
    {
      event = 'click',
      highlight = true,
      siblings = true,
      matchAllSlots = false,
      alphaTest = true,
      dragThreshold = 4,
    } = {},
  ) {
    const dom = this.renderer.domElement;
    let downX = 0;
    let downY = 0;
    let dragged = false;

    const onDown = (e) => {
      downX = e.clientX;
      downY = e.clientY;
      dragged = false;
    };
    const onMove = (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > dragThreshold) dragged = true;
    };

    const handler = (e) => {
      if (event === 'click' && dragged) return;
      const result = this.pick(e, { siblings, matchAllSlots, alphaTest });
      if (highlight) {
        if (result) this.#ensureHighlight().show(result);
        else this.highlight?.clear();
      }
      callback(result);
    };

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener(event, handler);

    const off = () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener(event, handler);
      this._pickSubs.delete(off);
    };
    this._pickSubs.add(off);
    return off;
  }

  #ensureHighlight() {
    if (!this.highlight) this.highlight = new PTHighlight(this._highlightOptions);
    return this.highlight;
  }

  /**
   * Outline a surface manually, without a pointer event.
   * @param {import('./build/picking.js').PTPickResult|THREE.Mesh|null} target
   */
  showHighlight(target) {
    this.#ensureHighlight().show(target);
    return this;
  }

  /** Remove the wireframe overlay. */
  clearHighlight() {
    this.highlight?.clear();
    return this;
  }

  // ------------------------------------------------------------- lifecycle ---

  /** Remove and dispose whatever is displayed. */
  clear() {
    // Overlays share geometry with the meshes they trace, so they must go
    // before the loader disposes anything.
    this.highlight?.clear();

    if (this.current) {
      this.scene.remove(this.current);
      this.loader.release(this.current);
      this.current = null;
    }
    this.mixer?.stopAllAction();
    this.mixer = null;
    this.action = null;
    this.character = null;
  }

  // -------------------------------------------------------------- camera ---

  /** Fit the camera to an object's bounding sphere. */
  frameObject(object, { padding = 1.6 } = {}) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.target.copy(sphere.center);

    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (sphere.radius * padding) / Math.sin(fov / 2);

    this._spherical.radius = distance;
    this._minDistance = Math.max(0.01, sphere.radius * 0.05);
    this._maxDistance = distance * 20;
    this.camera.near = Math.max(0.01, distance / 1000);
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
    this.#updateCamera();
  }

  #updateCamera() {
    const offset = new THREE.Vector3().setFromSpherical(this._spherical);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  // ------------------------------------------------------------ controls ---

  #bindControls() {
    const dom = this.renderer.domElement;
    const pointers = new Map();
    let mode = null;
    let last = { x: 0, y: 0 };
    let lastPinch = 0;

    const onDown = (e) => {
      if (!this.enabled) return;
      dom.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        mode = e.button === 2 || e.shiftKey ? 'pan' : 'rotate';
        last = { x: e.clientX, y: e.clientY };
      } else if (pointers.size === 2) {
        mode = 'pinch';
        lastPinch = pinchDistance(pointers);
      }
    };

    const onMove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (mode === 'pinch' && pointers.size >= 2) {
        const d = pinchDistance(pointers);
        if (lastPinch > 0) this.#zoom(lastPinch / d);
        lastPinch = d;
        return;
      }

      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };

      if (mode === 'rotate') {
        this._spherical.theta -= (dx / dom.clientWidth) * Math.PI * 2;
        this._spherical.phi -= (dy / dom.clientHeight) * Math.PI;
        this._spherical.phi = Math.max(0.02, Math.min(Math.PI - 0.02, this._spherical.phi));
      } else if (mode === 'pan') {
        const scale = (this._spherical.radius * 2) / dom.clientHeight;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
        this.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
      }
      this.#updateCamera();
    };

    const onUp = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) mode = null;
      else if (pointers.size === 1) {
        mode = 'rotate';
        const only = [...pointers.values()][0];
        last = { x: only.x, y: only.y };
      }
    };

    const onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.#zoom(e.deltaY > 0 ? 1.1 : 1 / 1.1);
    };

    dom.addEventListener('pointerdown', onDown);
    dom.addEventListener('pointermove', onMove);
    dom.addEventListener('pointerup', onUp);
    dom.addEventListener('pointercancel', onUp);
    dom.addEventListener('wheel', onWheel, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    this._unbindControls = () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointercancel', onUp);
      dom.removeEventListener('wheel', onWheel);
    };
  }

  #zoom(factor) {
    this._spherical.radius = Math.max(
      this._minDistance,
      Math.min(this._maxDistance, this._spherical.radius * factor),
    );
    this.#updateCamera();
  }

  // -------------------------------------------------------------- runtime ---

  #bindResize() {
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.#resize());
      this._ro.observe(this.container);
    } else {
      this._onWindowResize = () => this.#resize();
      globalThis.addEventListener?.('resize', this._onWindowResize);
    }
  }

  #resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  #loop() {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(() => this.#loop());

    const dt = this._clock.getDelta();
    const t = this._clock.elapsedTime;

    if (this.autoRotate && this.current) {
      this._spherical.theta += this.autoRotateSpeed * dt;
      this.#updateCamera();
    }

    this.loader.update(t);
    this.mixer?.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  /** Stop the loop and release every GPU resource, including the loader's. */
  dispose() {
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    for (const off of [...this._pickSubs]) off();
    this.clear();
    this.highlight?.dispose();
    this.highlight = null;
    this._unbindControls?.();
    this._ro?.disconnect();
    if (this._onWindowResize) globalThis.removeEventListener?.('resize', this._onWindowResize);
    this.loader.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function pinchDistance(pointers) {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export default PTViewer;
