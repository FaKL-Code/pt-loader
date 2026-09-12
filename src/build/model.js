import * as THREE from 'three';
import { FIXED, SCRIPT } from '../formats/constants.js';
import { bindMatrixOf } from './math.js';
import { buildGeometry, buildCollisionGeometry, computeSmoothNormals } from './geometry.js';
import {
  createMaterial,
  createWindAnimator,
  shouldSkipMaterial,
  isCollidable,
  windEffectOf,
} from './materials.js';
import { buildBones, createSkeleton, mapVertexBones } from './skeleton.js';

/** Rotation that maps the game's Z-up authoring space to three.js's Y-up. */
export const UP_AXIS_FIX = -Math.PI / 2;

/**
 * Compute final vertex positions for one `GeomObject`.
 *
 * @param {object} obj
 * @param {object|null} skeletonPat parsed `.smb`, when the object is skinned
 * @param {'matrix'|'trs'|'both'|'none'} mode
 * @returns {Float32Array} flat xyz, length nVertex * 3
 */
function computePositions(obj, skeletonPat, mode) {
  const n = obj.nVertex;
  const out = new Float32Array(n * 3);
  const v = new THREE.Vector3();

  const useMatrix = mode === 'matrix' || mode === 'both';
  if (!useMatrix) {
    for (let i = 0; i < n; i++) {
      const s = obj.vertices[i];
      out[i * 3] = s.x;
      out[i * 3 + 1] = s.y;
      out[i * 3 + 2] = s.z;
    }
    return out;
  }

  // Skinned objects transform each vertex by *its own bone's* bind matrix,
  // which places the mesh in skeleton space. Unskinned objects use their own.
  const boneIdx =
    obj.boneNames && skeletonPat ? mapVertexBones(obj.boneNames, skeletonPat.nameToIndex) : null;
  const own = bindMatrixOf(obj);
  const cache = new Map();

  for (let i = 0; i < n; i++) {
    let m = own;
    if (boneIdx) {
      const bi = boneIdx[i];
      if (bi >= 0) {
        let cached = cache.get(bi);
        if (!cached) {
          cached = bindMatrixOf(skeletonPat.objects[bi]);
          cache.set(bi, cached);
        }
        m = cached;
      }
    }
    const s = obj.vertices[i];
    v.set(s.x, s.y, s.z).applyMatrix4(m);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return out;
}

/** Per-object TRS as used by the reference renderer, with its axis swap. */
function applyObjectTRS(node, obj) {
  node.position.set(-obj.py, obj.pz, -obj.px);
  node.quaternion.set(-obj.qy, obj.qz, -obj.qx, -obj.qw).normalize();
  node.scale.set(obj.sy || 1, obj.sz || 1, obj.sx || 1);
}

/**
 * Turn a parsed PAT3D into a three.js scene graph.
 *
 * @param {object} pat parsed `.smd`
 * @param {object} opts
 * @param {(material:object, materialIndex:number)=>object} opts.resolveTextures
 *   synchronous lookup returning `{diffuse, lightmap, anim, diffuseHasAlpha}`;
 *   all textures must already be loaded
 * @param {object|null} [opts.skeletonPat] parsed `.smb`
 * @param {string} [opts.name]
 * @param {object} [opts.options]
 * @param {boolean} [opts.options.upAxisFix=true] apply the -90 degree X rotation
 * @param {'matrix'|'trs'|'both'|'none'} [opts.options.objectTransform='matrix']
 * @param {boolean} [opts.options.smoothNormals=false]
 * @param {'pose'|'matrix'} [opts.options.bindInverses='pose']
 * @param {'unshaded'|'lambert'} [opts.options.lighting='unshaded']
 * @returns {THREE.Group}
 */
export function buildModel(
  pat,
  { resolveTextures, skeletonPat = null, name = 'PAT3D', options = {} },
) {
  const {
    upAxisFix = true,
    objectTransform = 'matrix',
    smoothNormals = false,
    bindInverses = 'pose',
    lighting = 'unshaded',
    alphaTest = 0.5,
  } = options;

  const root = new THREE.Group();
  root.name = name;
  if (upAxisFix) root.rotation.x = UP_AXIS_FIX;

  const animators = [];
  const skinnedMeshes = [];
  const materials = pat.materialGroup?.materials ?? [];

  // ---- skeleton first: the bones must be in their final world position
  // before their inverse-bind matrices are derived. ----
  let skeleton = null;
  let boneIndexByName = null;
  if (skeletonPat && skeletonPat.objects.length > 0) {
    const { bones, roots, indexByName } = buildBones(skeletonPat);
    for (const r of roots) root.add(r);
    root.updateMatrixWorld(true);
    skeleton = createSkeleton(bones, skeletonPat.objects, {
      bindInverses,
      rootMatrix: root.matrixWorld,
    });
    boneIndexByName = indexByName;
    root.userData.ptBones = bones;
  }

  for (let oi = 0; oi < pat.objects.length; oi++) {
    const obj = pat.objects[oi];
    if (obj.nFace === 0 || obj.nVertex === 0) continue;

    const positions = computePositions(obj, skeletonPat, objectTransform);
    const normals = smoothNormals ? computeSmoothNormals(obj.faces, positions, obj.nVertex) : null;

    const skinBones =
      skeleton && obj.boneNames && boneIndexByName
        ? mapVertexBones(obj.boneNames, boneIndexByName)
        : null;

    for (let matId = 0; matId < materials.length; matId++) {
      const m = materials[matId];
      if (shouldSkipMaterial(m)) continue;

      const geometry = buildGeometry({
        faces: obj.faces,
        texLinks: obj.texLinks,
        positions,
        matId,
        normals,
        boneIndex: skinBones,
      });
      if (!geometry) continue;

      const tex = resolveTextures(m, matId);
      const { material, animator } = createMaterial(m, tex, { lighting, alphaTest });
      if (animator) animators.push(animator);

      const mesh = skinBones
        ? new THREE.SkinnedMesh(geometry, material)
        : new THREE.Mesh(geometry, material);
      mesh.name = `${obj.nodeName || `obj${oi}`}#${matId}`;
      mesh.userData.pt = {
        objectIndex: oi,
        nodeName: obj.nodeName,
        materialIndex: matId,
        ...material.userData.pt,
      };

      if (objectTransform === 'trs' || objectTransform === 'both') applyObjectTRS(mesh, obj);

      root.add(mesh);

      if (skinBones) {
        mesh.frustumCulled = false; // bounds do not follow the skeleton
        skinnedMeshes.push(mesh);
      }

      const wind = windEffectOf(m);
      if (wind && wind !== SCRIPT.WATER) animators.push(createWindAnimator(mesh, wind));
    }
  }

  // ---- bind after the whole hierarchy exists ----
  if (skeleton) {
    root.updateMatrixWorld(true);
    for (const mesh of skinnedMeshes) {
      if (bindInverses === 'matrix') mesh.bind(skeleton, mesh.matrixWorld.clone());
      else mesh.bind(skeleton);
    }
    root.userData.ptSkeleton = skeleton;
  }

  attachUpdater(root, animators);
  return root;
}

/**
 * Turn a parsed STAGE3D map into a three.js scene graph.
 *
 * Map vertices are already in world space, so there is no per-object transform
 * and no skeleton — just one mesh per material.
 *
 * @param {object} stage parsed map
 * @param {object} opts
 * @param {(material:object, materialIndex:number)=>object} opts.resolveTextures
 * @param {string} [opts.name]
 * @param {object} [opts.options]
 * @param {boolean} [opts.options.vertexColors=false]
 * @param {boolean} [opts.options.smoothNormals=false]
 * @param {'unshaded'|'lambert'} [opts.options.lighting='unshaded']
 * @returns {THREE.Group}
 */
export function buildStage(stage, { resolveTextures, name = 'STAGE3D', options = {} }) {
  const {
    vertexColors = false,
    smoothNormals = false,
    lighting = 'unshaded',
    alphaTest = 0.5,
  } = options;

  const root = new THREE.Group();
  root.name = name;

  const count = stage.vertices.length;
  const positions = new Float32Array(count * 3);
  const colors = vertexColors ? new Float32Array(count * 4) : null;

  for (let i = 0; i < count; i++) {
    const v = stage.vertices[i];
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
    if (colors) {
      colors[i * 4] = v.r;
      colors[i * 4 + 1] = v.g;
      colors[i * 4 + 2] = v.b;
      colors[i * 4 + 3] = v.a;
    }
  }

  const normals = smoothNormals ? computeSmoothNormals(stage.faces, positions, count) : null;
  const materials = stage.materialGroup?.materials ?? [];
  const animators = [];

  for (let matId = 0; matId < materials.length; matId++) {
    const m = materials[matId];
    if (shouldSkipMaterial(m)) continue;

    const geometry = buildGeometry({
      faces: stage.faces,
      texLinks: stage.texLinks,
      positions,
      matId,
      normals,
      colors,
      fallbackUV: false, // StageFace has no inline UVs
    });
    if (!geometry) continue;

    const tex = resolveTextures(m, matId);
    const { material, animator } = createMaterial(m, tex, { lighting, alphaTest, vertexColors });
    if (animator) animators.push(animator);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${name}#${matId}`;
    mesh.userData.pt = { materialIndex: matId, ...material.userData.pt };
    root.add(mesh);

    const wind = windEffectOf(m);
    if (wind && wind !== SCRIPT.WATER) animators.push(createWindAnimator(mesh, wind));
  }

  root.userData.ptLights = stage.lights;
  root.userData.ptRect = stage.rect;
  attachUpdater(root, animators);
  return root;
}

/**
 * Collision mesh for a parsed map or model: only faces whose material has
 * `MeshState & 1`. Indexed and welded, so it is far smaller than the visual
 * mesh and suitable for raycasting.
 *
 * @param {object} parsed output of `parseSTAGE3D` or a single PAT3D object
 * @returns {THREE.Mesh|null}
 */
export function buildCollisionMesh(parsed) {
  const materials = parsed.materialGroup?.materials ?? [];
  const isStage = parsed.type === 'stage3d';

  const faces = isStage ? parsed.faces : parsed.objects.flatMap((o) => o.faces);
  const verts = isStage ? parsed.vertices : parsed.objects.flatMap((o) => o.vertices);
  const positions = new Float32Array(verts.length * 3);
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = verts[i].x;
    positions[i * 3 + 1] = verts[i].y;
    positions[i * 3 + 2] = verts[i].z;
  }

  const geometry = buildCollisionGeometry(faces, positions, (matId) =>
    isCollidable(materials[matId]),
  );
  if (!geometry) return null;

  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));
  mesh.name = 'pt_collision';
  return mesh;
}

/** Attach `userData.ptAnimators` and a single `userData.ptUpdate(time)` hook. */
function attachUpdater(root, animators) {
  root.userData.ptAnimators = animators;
  root.userData.ptUpdate = animators.length
    ? (time) => {
        for (const a of animators) a.update(time);
      }
    : () => {};
}

/** Scale factor from raw file units to the units used by this loader. */
export const UNIT_SCALE = 1 / FIXED;
