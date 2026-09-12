import * as THREE from 'three';

/**
 * Surface picking and highlighting.
 *
 * This reproduces the texture picker of the original JPsTale FieldBox tool:
 * click a surface, learn which texture it uses, and see every other surface in
 * the scene that shares it. The data it reads comes from `userData.pt`, which
 * every mesh built by this package carries.
 */

const _raycaster = new THREE.Raycaster();
const _pointer = new THREE.Vector2();

/**
 * Convert a pointer/mouse event into normalised device coordinates.
 * @param {{clientX:number, clientY:number}} event
 * @param {HTMLElement} domElement the canvas the event was delivered to
 * @param {THREE.Vector2} [target]
 */
export function pointerToNDC(event, domElement, target = new THREE.Vector2()) {
  const rect = domElement.getBoundingClientRect();
  target.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  target.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  return target;
}

/**
 * Read the alpha channel of a texture at a UV coordinate.
 *
 * Only works for textures this package decoded itself (`DataTexture`, whose
 * pixels stay on the CPU). Browser-decoded images return 255, because their
 * pixels live only on the GPU — the caller then treats the hit as opaque.
 *
 * The data is bottom-up and the UV attribute already carries the `1 - v` flip,
 * so `v` maps straight onto the row index.
 *
 * @param {THREE.Texture|null} texture
 * @param {number} u
 * @param {number} v
 * @returns {number} 0..255
 */
export function sampleTextureAlpha(texture, u, v) {
  const image = texture?.image;
  const data = image?.data;
  if (!data || !image.width || !image.height) return 255;

  const wrap = (t) => ((t % 1) + 1) % 1;
  const x = Math.min(image.width - 1, Math.floor(wrap(u) * image.width));
  const y = Math.min(image.height - 1, Math.floor(wrap(v) * image.height));

  return data[(y * image.width + x) * 4 + 3];
}

/**
 * Every mesh under `root` that uses a given texture.
 *
 * @param {THREE.Object3D} root
 * @param {string} textureName as stored in the material, e.g. `"rock02.bmp"`
 * @param {{matchAllSlots?: boolean}} [opts] also match the lightmap and
 *   flipbook slots instead of just the diffuse map
 * @returns {THREE.Mesh[]}
 */
export function findMeshesByTexture(root, textureName, { matchAllSlots = false } = {}) {
  if (!textureName) return [];
  const want = String(textureName).toLowerCase();
  const out = [];

  root.traverse((o) => {
    if (!o.isMesh || o.userData?.ptHighlight) return;
    const pt = o.userData?.pt;
    if (!pt) return;

    const names = matchAllSlots
      ? [...(pt.textureNames ?? []), ...(pt.animTextureNames ?? [])]
      : [pt.textureNames?.[0]];

    if (names.some((n) => n && n.toLowerCase() === want)) out.push(o);
  });

  return out;
}

/**
 * Raycast into a loaded object and describe the surface that was hit.
 *
 * @param {object} opts
 * @param {THREE.Object3D} opts.root object returned by a `load*` call
 * @param {THREE.Camera} opts.camera
 * @param {THREE.Vector2|{x:number,y:number}} opts.pointer normalised device coordinates
 * @param {THREE.Raycaster} [opts.raycaster] reuse your own
 * @param {boolean} [opts.siblings=true] also collect surfaces sharing the texture
 * @param {boolean} [opts.matchAllSlots=false] widen the sibling match
 * @param {boolean} [opts.alphaTest=true] ignore hits on transparent texels of
 *   cutout materials, so clicking through a fence selects what is behind it
 * @param {(mesh: THREE.Mesh, hit: THREE.Intersection) => boolean} [opts.filter]
 * @returns {PTPickResult|null}
 */
export function pickAt({
  root,
  camera,
  pointer,
  raycaster = _raycaster,
  siblings = true,
  matchAllSlots = false,
  alphaTest = true,
  filter = null,
}) {
  if (!root || !camera) return null;

  _pointer.set(pointer.x, pointer.y);
  raycaster.setFromCamera(_pointer, camera);

  for (const hit of raycaster.intersectObject(root, true)) {
    const mesh = hit.object;
    if (!mesh.isMesh) continue;
    // Never select our own wireframe overlays or the invisible collision mesh.
    if (mesh.userData?.ptHighlight) continue;
    if (mesh.material?.visible === false) continue;
    if (filter && !filter(mesh, hit)) continue;

    // Cutout materials are mostly holes; a hit on a transparent texel is not a
    // hit on the surface a person sees.
    if (alphaTest && mesh.material?.alphaTest > 0 && hit.uv) {
      const a = sampleTextureAlpha(mesh.material.map, hit.uv.x, hit.uv.y) / 255;
      if (a < mesh.material.alphaTest) continue;
    }

    const pt = mesh.userData?.pt ?? {};
    const textureName = pt.textureNames?.[0] ?? null;

    return {
      mesh,
      root,
      point: hit.point.clone(),
      distance: hit.distance,
      faceIndex: hit.faceIndex ?? null,
      uv: hit.uv ? hit.uv.clone() : null,
      textureName,
      textureNames: pt.textureNames ?? [],
      animTextureNames: pt.animTextureNames ?? [],
      materialIndex: pt.materialIndex ?? null,
      nodeName: pt.nodeName ?? null,
      objectIndex: pt.objectIndex ?? null,
      blendType: pt.blendType ?? null,
      useState: pt.useState ?? null,
      meshState: pt.meshState ?? null,
      mapOpacity: pt.mapOpacity ?? null,
      transparency: pt.transparency ?? null,
      twoSide: pt.twoSide ?? null,
      siblings:
        siblings && textureName
          ? findMeshesByTexture(root, textureName, { matchAllSlots }).filter((m) => m !== mesh)
          : [],
    };
  }

  return null;
}

/**
 * @typedef {object} PTPickResult
 * @property {THREE.Mesh} mesh the surface that was hit
 * @property {THREE.Vector3} point world-space hit position
 * @property {string|null} textureName primary diffuse texture
 * @property {THREE.Mesh[]} siblings other surfaces using the same texture
 */

/**
 * Wireframe overlay for a picked surface and its siblings.
 *
 * Overlays are added as children of the meshes they trace, so they inherit the
 * exact transform, and skinned surfaces get a `SkinnedMesh` overlay bound to the
 * same skeleton so the outline follows the animation.
 */
export class PTHighlight {
  /**
   * @param {object} [opts]
   * @param {number|string} [opts.color=0x3cf0b4] outline of the picked surface
   * @param {number|string} [opts.siblingColor=0xff8a3c] outline of surfaces sharing the texture
   * @param {number} [opts.opacity=0.95]
   * @param {number} [opts.siblingOpacity=0.5]
   * @param {boolean} [opts.xray=true] draw through geometry, so siblings behind
   *   walls are still visible — that is the point of the sibling highlight
   * @param {number} [opts.renderOrder=999]
   */
  constructor({
    color = 0x3cf0b4,
    siblingColor = 0xff8a3c,
    opacity = 0.95,
    siblingOpacity = 0.5,
    xray = true,
    renderOrder = 999,
  } = {}) {
    this.renderOrder = renderOrder;
    this.primaryMaterial = makeWireMaterial(color, opacity, xray);
    this.siblingMaterial = makeWireMaterial(siblingColor, siblingOpacity, xray);
    /** @type {Map<THREE.Mesh, THREE.Mesh>} */
    this.overlays = new Map();
  }

  /**
   * Outline a surface and, optionally, its siblings. Replaces any previous
   * highlight.
   * @param {PTPickResult|THREE.Mesh|null} target
   * @param {THREE.Mesh[]} [siblings]
   */
  show(target, siblings) {
    this.clear();
    if (!target) return this;

    const mesh = target.isMesh ? target : target.mesh;
    const others = siblings ?? (target.isMesh ? [] : (target.siblings ?? []));
    if (!mesh) return this;

    for (const s of others) this.#add(s, this.siblingMaterial);
    this.#add(mesh, this.primaryMaterial);
    return this;
  }

  #add(mesh, material) {
    if (!mesh?.isMesh || this.overlays.has(mesh)) return;

    let overlay;
    if (mesh.isSkinnedMesh && mesh.skeleton) {
      overlay = new THREE.SkinnedMesh(mesh.geometry, material);
      overlay.bind(mesh.skeleton, mesh.bindMatrix.clone());
      overlay.frustumCulled = false;
    } else {
      overlay = new THREE.Mesh(mesh.geometry, material);
    }

    overlay.name = `${mesh.name}#ptHighlight`;
    overlay.userData.ptHighlight = true;
    overlay.renderOrder = this.renderOrder;
    overlay.matrixAutoUpdate = false; // identity local transform
    overlay.raycast = () => {}; // never pickable

    mesh.add(overlay);
    this.overlays.set(mesh, overlay);
  }

  /** Remove every overlay. Geometries are shared and are never disposed here. */
  clear() {
    for (const overlay of this.overlays.values()) overlay.removeFromParent();
    this.overlays.clear();
    return this;
  }

  /** True while something is highlighted. */
  get active() {
    return this.overlays.size > 0;
  }

  /** Remove the overlays and dispose the two shared materials. */
  dispose() {
    this.clear();
    this.primaryMaterial.dispose();
    this.siblingMaterial.dispose();
  }
}

function makeWireMaterial(color, opacity, xray) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    wireframe: true,
    transparent: true,
    opacity,
    depthTest: !xray,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
}
