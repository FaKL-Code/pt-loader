import * as THREE from 'three';
import { BLEND, TEX_TYPE, SCRIPT, WIND_MASK, MESH_STATE_COLLIDE } from '../formats/constants.js';

/**
 * Materials that must never produce geometry:
 *   - not in use
 *   - no texture at all
 *   - explicitly invisible (`sMATS_SCRIPT_NOTVIEW`) — invisible collision hulls
 * @param {object} m
 */
export function shouldSkipMaterial(m) {
  if (!m) return true;
  if (m.inUse === 0) return true;
  if (m.textureCounter === 0 && m.animTexCounter === 0) return true;
  if ((m.useState & SCRIPT.NOTVIEW) !== 0) return true;
  return false;
}

/** True when faces using this material participate in collision detection. */
export function isCollidable(m) {
  return !!m && (m.meshState & MESH_STATE_COLLIDE) !== 0;
}

/**
 * Scroll speed, decoded from `TextureFormState[0]`.
 * Values 4/5/6 are SCROLL / REFLEX / SCROLL2 in the original engine.
 * @param {object} m
 */
export function scrollSpeedOf(m) {
  const n = m.textureFormState[0];
  if (n >= 6 && n <= 14) return 15 - n;
  if (n >= 15 && n <= 18) return (128 >> (18 - n + 4)) / 256;
  return 1;
}

/** True when the material scrolls its UVs. */
export function isScrolling(m) {
  return m.textureType === TEX_TYPE.MULTIMIX && m.textureFormState[0] >= 4;
}

/** Wind/water effect encoded in `WindMeshBottom`, or 0 when there is none. */
export function windEffectOf(m) {
  if (m.windMeshBottom === 0) return 0;
  if ((m.useState & SCRIPT.BLINK_COLOR) !== 0) return 0;
  const kind = m.windMeshBottom & WIND_MASK;
  switch (kind) {
    case SCRIPT.WINDX1:
    case SCRIPT.WINDX2:
    case SCRIPT.WINDZ1:
    case SCRIPT.WINDZ2:
    case SCRIPT.WATER:
      return kind;
    default:
      return 0;
  }
}

/**
 * Translate a `_Material` into a three.js material plus an optional animator.
 *
 * Rule order matters and mirrors the reference renderer:
 *   1. cutout (`MapOpacity`)      — alpha test, stays in the opaque queue
 *   2. semi-transparent (`Transparency`) — real blending, no depth write
 *   3. auto-detected alpha        — same treatment as cutout
 *
 * @param {object} m parsed `_Material`
 * @param {object} tex resolved textures
 * @param {THREE.Texture|null} tex.diffuse
 * @param {THREE.Texture|null} [tex.lightmap]
 * @param {THREE.Texture[]} [tex.anim] flipbook frames
 * @param {boolean} [tex.diffuseHasAlpha]
 * @param {object} [options]
 * @param {'unshaded'|'lambert'} [options.lighting='unshaded']
 * @param {number} [options.alphaTest=0.5]
 * @param {boolean} [options.vertexColors=false]
 * @returns {{material: THREE.Material, animator: {update:(t:number)=>void}|null}}
 */
export function createMaterial(m, tex, options = {}) {
  const { lighting = 'unshaded', alphaTest = 0.5, vertexColors = false } = options;

  const isFlipbook = m.textureType === TEX_TYPE.ANIMATION && m.animTexCounter > 0;
  const frames = tex.anim ?? [];
  const map = isFlipbook ? (frames[0] ?? tex.diffuse ?? null) : (tex.diffuse ?? null);

  const params = { map, vertexColors };
  const material =
    lighting === 'lambert'
      ? new THREE.MeshLambertMaterial({
          ...params,
          color: new THREE.Color(m.diffuse.r || 1, m.diffuse.g || 1, m.diffuse.b || 1),
          emissive: new THREE.Color(0, 0, 0),
          emissiveIntensity: m.selfIllum || 0,
        })
      : new THREE.MeshBasicMaterial({ ...params, color: 0xffffff });

  if (tex.lightmap) {
    material.lightMap = tex.lightmap;
    material.lightMapIntensity = 1;
    // The lightmap uses the second UV set; three.js reads it from `uv1` when
    // the texture's channel is 1.
    tex.lightmap.channel = 1;
  }

  // ---- base blend state ----
  switch (m.blendType) {
    case BLEND.ALPHA:
      material.transparent = true;
      material.blending = THREE.NormalBlending;
      break;
    case BLEND.COLOR:
      material.transparent = true;
      material.blending = THREE.MultiplyBlending;
      break;
    case BLEND.LAMP:
    case BLEND.ADDCOLOR:
      material.transparent = true;
      material.blending = THREE.AdditiveBlending;
      material.depthWrite = false;
      break;
    default:
      break; // NONE / SHADOW / INVSHADOW render opaque
  }

  if (m.twoSide === 1 || m.textureType === TEX_TYPE.ANIMATION) {
    material.side = THREE.DoubleSide;
  }

  // ---- 1. cutout ----
  if (m.mapOpacity !== 0) {
    applyCutout(material, alphaTest);
  }
  // ---- 2. semi-transparent ----
  else if (m.transparency !== 0) {
    material.transparent = true;
    material.opacity = clamp01(1 - m.transparency);
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
  }
  // ---- 3. auto-detected alpha ----
  else if (m.blendType === BLEND.NONE && tex.diffuseHasAlpha) {
    applyCutout(material, alphaTest);
  }

  material.name = `pt_mat_${m.serialNum ?? 0}`;
  material.userData = {
    pt: {
      blendType: m.blendType,
      textureType: m.textureType,
      useState: m.useState,
      meshState: m.meshState,
      mapOpacity: m.mapOpacity,
      transparency: m.transparency,
      twoSide: m.twoSide,
      windMeshBottom: m.windMeshBottom,
      textureNames: m.textures.map((t) => t.name),
      animTextureNames: m.animTextures.map((t) => t.name),
    },
  };

  const animator = createAnimator(m, material, tex, frames);
  return { material, animator };
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/**
 * Alpha-test cutout: fences, foliage, railings.
 *
 * Mipmaps average the alpha channel, so at distance a 0/1 alpha mask drifts
 * toward the threshold and a fence becomes a solid wall that occludes the
 * scene. Disabling mipmaps on the diffuse map trades distant aliasing for
 * correctness, which is the right trade here.
 */
function applyCutout(material, alphaTest) {
  material.alphaTest = alphaTest;
  material.transparent = false;
  material.blending = THREE.NormalBlending;
  material.depthWrite = true;
  material.depthTest = true;
  material.side = THREE.DoubleSide;
  if (material.map) {
    material.map.minFilter = THREE.LinearFilter;
    material.map.magFilter = THREE.LinearFilter;
    material.map.generateMipmaps = false;
    material.map.needsUpdate = true;
  }
}

/**
 * Build the per-frame updater for an animated material, or null.
 * All three effects are plain texture-offset or map swaps — no custom shader.
 */
function createAnimator(m, material, tex, frames) {
  // Flipbook: swap the whole texture on a fixed interval.
  if (m.textureType === TEX_TYPE.ANIMATION && frames.length > 1) {
    const interval = (1 << Math.max(0, m.shiftFrameSpeed)) / 1000;
    let last = -1;
    return {
      kind: 'flipbook',
      material,
      update(t) {
        const n = Math.floor(t / interval) % frames.length;
        if (n !== last) {
          last = n;
          material.map = frames[n];
          material.needsUpdate = true;
        }
      },
    };
  }

  const wind = windEffectOf(m);

  // Water: UV orbiting a small circle, 8 s period.
  if (wind === SCRIPT.WATER) {
    const maps = [material.map, material.lightMap].filter(Boolean);
    return {
      kind: 'water',
      material,
      update(t) {
        const a = 2 * Math.PI * t * 0.125;
        const x = Math.sin(a) * 0.2;
        const y = Math.cos(a) * 0.2;
        for (const mp of maps) mp.offset.set(x, y);
      },
    };
  }

  // Scroll: UV sliding along X.
  if (isScrolling(m)) {
    const speed = scrollSpeedOf(m);
    const maps = [material.map, material.lightMap].filter(Boolean);
    return {
      kind: 'scroll',
      material,
      speed,
      update(t) {
        const x = speed * t * 0.1;
        for (const mp of maps) mp.offset.x = x;
      },
    };
  }

  return null;
}

/**
 * Object-level wind sway. Not a shader in the original engine either — the
 * whole node is translated on a 4 s sine.
 *
 * Note the axis mapping is as-shipped: WINDX1 moves Z, WINDX2 moves X.
 *
 * @param {THREE.Object3D} object
 * @param {number} kind one of SCRIPT.WINDX1/X2/Z1/Z2
 */
export function createWindAnimator(object, kind) {
  const base = object.position.clone();
  return {
    kind: 'wind',
    object,
    update(t) {
      const a = (2 * Math.PI * (t % 4)) / 4;
      const s = Math.sin(a);
      let dx = 0;
      let dz = 0;
      switch (kind) {
        case SCRIPT.WINDX1:
          dz = 2 * s;
          break;
        case SCRIPT.WINDZ1:
          dx = 2 * s;
          break;
        case SCRIPT.WINDX2:
          dx = 2 * s;
          break;
        case SCRIPT.WINDZ2:
          dz = 8 * s;
          break;
        default:
          return;
      }
      object.position.set(base.x + dx, base.y, base.z + dz);
    },
  };
}
