import * as THREE from 'three';
import { bindQuaternion, inverseBindMatrixOf, invertSafe } from './math.js';

/**
 * Build a `THREE.Skeleton` from a parsed `.smb` (or from a `.smd` whose objects
 * double as bones).
 *
 * Bone names are sanitised for `THREE.PropertyBinding`, which is what resolves
 * animation track targets. The original, unsanitised names are kept in
 * `indexByName` because the per-vertex skin binding references them verbatim.
 *
 * Binding contract (see `buildModel`): the bones must already sit under their
 * final parent with its transform applied before the skeleton's inverses are
 * computed, otherwise the root rotation is applied twice at render time.
 *
 * @param {{objects: object[]}} pat parsed PAT3D acting as the skeleton
 * @returns {{bones: THREE.Bone[], roots: THREE.Bone[], indexByName: Map<string, number>}}
 */
export function buildBones(pat) {
  const objects = pat.objects;
  const bones = [];
  const indexByName = new Map();

  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    const bone = new THREE.Bone();
    bone.name = THREE.PropertyBinding.sanitizeNodeName(o.nodeName || `bone_${i}`);
    bone.position.set(o.px, o.py, o.pz);
    bone.quaternion.copy(bindQuaternion(o));
    bone.scale.set(o.sx || 1, o.sy || 1, o.sz || 1);
    bone.userData.pt = { nodeName: o.nodeName, nodeParent: o.nodeParent, index: i };
    bones.push(bone);
    if (o.nodeName) indexByName.set(o.nodeName, i);
  }

  const roots = [];
  for (let i = 0; i < objects.length; i++) {
    const parent = objects[i].parentIndex;
    if (parent >= 0 && parent !== i) bones[parent].add(bones[i]);
    else roots.push(bones[i]);
  }

  return { bones, roots, indexByName };
}

/**
 * Create the `THREE.Skeleton` once the bones are in their final hierarchy.
 *
 * @param {THREE.Bone[]} bones
 * @param {object[]} objects parsed GeomObjects, index-aligned with `bones`
 * @param {object} [options]
 * @param {'pose'|'matrix'} [options.bindInverses='pose']
 *   `'pose'` derives the inverse-bind matrices from the bone hierarchy built
 *   from `p`/`q`/`s` — this is what the reference renderer effectively does and
 *   is self-consistent by construction.
 *   `'matrix'` uses the file's own `transformInvert` instead. Use it if a model
 *   renders in a visibly broken rest pose; the two agree whenever the file's
 *   decomposed transform matches its matrix.
 * @param {THREE.Matrix4} [options.rootMatrix] world matrix applied to the bone
 *   roots, needed to keep `'matrix'` mode consistent with the scene graph
 */
export function createSkeleton(bones, objects, options = {}) {
  const { bindInverses = 'pose', rootMatrix = null } = options;

  if (bindInverses === 'matrix') {
    const rootInv = rootMatrix ? invertSafe(rootMatrix) : new THREE.Matrix4();
    const inverses = objects.map((o) => inverseBindMatrixOf(o).multiply(rootInv));
    return new THREE.Skeleton(bones, inverses);
  }

  // `Skeleton` computes the inverses from each bone's current `matrixWorld`.
  for (const b of bones) if (!b.parent) b.updateMatrixWorld(true);
  return new THREE.Skeleton(bones);
}

/**
 * Map the per-vertex bone names of a mesh object onto skeleton bone indices.
 * Unmatched names yield `-1`; `buildGeometry` binds those vertices to bone 0,
 * which keeps the mesh renderable instead of dropping triangles.
 *
 * @param {string[]} boneNames per-vertex, length nVertex
 * @param {Map<string, number>} indexByName from `buildBones`
 */
export function mapVertexBones(boneNames, indexByName) {
  const out = new Int32Array(boneNames.length);
  for (let i = 0; i < boneNames.length; i++) {
    const idx = indexByName.get(boneNames[i]);
    out[i] = idx === undefined ? -1 : idx;
  }
  return out;
}
