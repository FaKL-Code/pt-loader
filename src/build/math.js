import * as THREE from 'three';

/**
 * Convert a `Matrix4D` read from disk into a `THREE.Matrix4`.
 *
 * The file stores 16 fixed-point integers row-major in Direct3D's row-vector
 * convention (`_11 _12 _13 _14 _21 ...`). three.js uses column vectors, so the
 * matrix must be transposed. `readMatrix4D` already divided by 256.
 *
 * Sanity check: for a well-formed matrix `_44 === 256`, so `elements[15]` of
 * the result is exactly 1. If you get 256 or 1/256, the division is wrong.
 *
 * @param {Float64Array|number[]} f 16 values in file order
 * @param {THREE.Matrix4} [target]
 */
export function mat4FromFile(f, target = new THREE.Matrix4()) {
  // THREE.Matrix4.set() takes arguments row-major; passing the transpose of `f`
  // yields M[r][c] = f[c * 4 + r].
  return target.set(
    f[0],
    f[4],
    f[8],
    f[12],
    f[1],
    f[5],
    f[9],
    f[13],
    f[2],
    f[6],
    f[10],
    f[14],
    f[3],
    f[7],
    f[11],
    f[15],
  );
}

/**
 * Invert a matrix, falling back to the identity when it is degenerate.
 * `THREE.Matrix4.invert()` silently returns a zero matrix for a zero
 * determinant, which would collapse every vertex onto the origin.
 * @param {THREE.Matrix4} m
 */
export function invertSafe(m) {
  const out = m.clone();
  if (Math.abs(m.determinant()) < 1e-12) return out.identity();
  return out.invert();
}

/**
 * The bind transform of a `GeomObject`: the inverse of the stored
 * `transformInvert`.
 * @param {{transformInvert: Float64Array}} obj
 */
export function bindMatrixOf(obj) {
  return invertSafe(mat4FromFile(obj.transformInvert));
}

/** The stored inverse-bind matrix, usable directly as a `THREE.Skeleton` boneInverse. */
export function inverseBindMatrixOf(obj) {
  return mat4FromFile(obj.transformInvert);
}

/**
 * Bind-pose quaternion as stored, with the `w` negation the reference loader
 * applies when constructing bones.
 * @param {{qx:number,qy:number,qz:number,qw:number}} obj
 */
export function bindQuaternion(obj) {
  return new THREE.Quaternion(obj.qx, obj.qy, obj.qz, -obj.qw).normalize();
}

/**
 * Bind-pose rotation used as the reference frame for animation tracks.
 * `(-qx, -qy, -qz, qw)` is the same rotation as `bindQuaternion` (q and -q are
 * equivalent); it is kept separate to mirror the reference implementation
 * exactly.
 * @param {{qx:number,qy:number,qz:number,qw:number}} obj
 */
export function trackBindRotation(obj) {
  return new THREE.Quaternion(-obj.qx, -obj.qy, -obj.qz, obj.qw).normalize();
}
