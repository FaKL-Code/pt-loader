import * as THREE from 'three';

/**
 * Average face normals per original vertex index.
 *
 * The reference implementation does this in O(nVertex * nFace), which is
 * unusable on a real map. This builds the adjacency implicitly in O(nFace).
 *
 * @param {{v:number[]}[]} faces every face of the object, all materials
 * @param {Float32Array} positions flat xyz, length vertexCount * 3
 * @param {number} vertexCount
 * @returns {Float32Array} flat xyz normals, length vertexCount * 3
 */
export function computeSmoothNormals(faces, positions, vertexCount) {
  const normals = new Float32Array(vertexCount * 3);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (const f of faces) {
    const [i0, i1, i2] = f.v;
    if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) continue;

    a.fromArray(positions, i0 * 3);
    b.fromArray(positions, i1 * 3);
    c.fromArray(positions, i2 * 3);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    if (n.lengthSq() === 0) continue;
    n.normalize();

    for (const i of f.v) {
      normals[i * 3] += n.x;
      normals[i * 3 + 1] += n.y;
      normals[i * 3 + 2] += n.z;
    }
  }

  for (let i = 0; i < vertexCount; i++) {
    n.fromArray(normals, i * 3);
    if (n.lengthSq() === 0) n.set(0, 1, 0);
    else n.normalize();
    n.toArray(normals, i * 3);
  }
  return normals;
}

/**
 * Build one non-indexed `BufferGeometry` from every face that uses `matId`.
 *
 * The mesh is non-indexed on purpose: UVs are stored per face, not per vertex,
 * so the same vertex can carry different UVs in different triangles. Welding is
 * a job for the offline pipeline, where it can be done safely.
 *
 * UV convention: the game stores Direct3D UVs (`v = 0` is the top of the
 * image). Textures produced by this package are bottom-up with `flipY = false`,
 * so the V coordinate is flipped here with `1 - v`.
 *
 * @param {object} opts
 * @param {{v:number[], matId:number, texIndex:number, t?:number[][]}[]} opts.faces
 * @param {{u:number[], v:number[], nextIndex:number}[]} opts.texLinks
 * @param {Float32Array} opts.positions flat xyz in final space
 * @param {number} opts.matId
 * @param {Float32Array} [opts.normals] per-vertex smooth normals
 * @param {Float32Array} [opts.colors] per-vertex rgba, length vertexCount * 4
 * @param {Int32Array} [opts.boneIndex] per-vertex bone index for rigid skinning
 * @param {boolean} [opts.fallbackUV] use the face's inline UVs when no TexLink
 * @returns {THREE.BufferGeometry|null} null when no face uses this material
 */
export function buildGeometry({
  faces,
  texLinks,
  positions,
  matId,
  normals = null,
  colors = null,
  boneIndex = null,
  fallbackUV = true,
}) {
  const selected = [];
  for (const f of faces) if (f.matId === matId) selected.push(f);
  if (selected.length === 0) return null;

  const n = selected.length * 3;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const uv1 = new Float32Array(n * 2);
  const nrm = normals ? new Float32Array(n * 3) : null;
  const col = colors ? new Float32Array(n * 3) : null;
  const skinIndex = boneIndex ? new Uint16Array(n * 4) : null;
  const skinWeight = boneIndex ? new Float32Array(n * 4) : null;

  let hasUV1 = false;
  const vertexCount = positions.length / 3;

  for (let i = 0; i < selected.length; i++) {
    const f = selected[i];
    const tl = f.texIndex >= 0 ? texLinks[f.texIndex] : null;
    const tl2 = tl && tl.nextIndex >= 0 ? texLinks[tl.nextIndex] : null;
    if (tl2) hasUV1 = true;

    for (let k = 0; k < 3; k++) {
      const vi = i * 3 + k;
      const src = f.v[k];
      if (src >= vertexCount) continue;

      pos[vi * 3] = positions[src * 3];
      pos[vi * 3 + 1] = positions[src * 3 + 1];
      pos[vi * 3 + 2] = positions[src * 3 + 2];

      if (nrm) {
        nrm[vi * 3] = normals[src * 3];
        nrm[vi * 3 + 1] = normals[src * 3 + 1];
        nrm[vi * 3 + 2] = normals[src * 3 + 2];
      }

      if (col) {
        col[vi * 3] = colors[src * 4];
        col[vi * 3 + 1] = colors[src * 4 + 1];
        col[vi * 3 + 2] = colors[src * 4 + 2];
      }

      if (tl) {
        uv[vi * 2] = tl.u[k];
        uv[vi * 2 + 1] = 1 - tl.v[k];
      } else if (fallbackUV && f.t) {
        uv[vi * 2] = f.t[k][0];
        uv[vi * 2 + 1] = 1 - f.t[k][1];
      }

      if (tl2) {
        uv1[vi * 2] = tl2.u[k];
        uv1[vi * 2 + 1] = 1 - tl2.v[k];
      }

      if (skinIndex) {
        const bi = boneIndex[src];
        skinIndex[vi * 4] = bi >= 0 ? bi : 0;
        skinWeight[vi * 4] = 1;
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (hasUV1) g.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  if (nrm) g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  else g.computeVertexNormals();
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (skinIndex) {
    g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  }

  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Build a collision-only mesh: an indexed geometry containing just the faces
 * whose material has `MeshState & 1`. Typically a small fraction of the visual
 * mesh, and suitable for raycasting.
 *
 * @param {{v:number[], matId:number}[]} faces
 * @param {Float32Array} positions
 * @param {(matId:number)=>boolean} isCollidable
 */
export function buildCollisionGeometry(faces, positions, isCollidable) {
  const vertexCount = positions.length / 3;
  const remap = new Int32Array(vertexCount).fill(-1);
  const selected = [];

  for (const f of faces) {
    if (!isCollidable(f.matId)) continue;
    selected.push(f);
    for (const i of f.v) if (i < vertexCount) remap[i] = 0;
  }
  if (selected.length === 0) return null;

  let next = 0;
  for (let i = 0; i < vertexCount; i++) if (remap[i] === 0) remap[i] = next++;

  const pos = new Float32Array(next * 3);
  for (let i = 0; i < vertexCount; i++) {
    const j = remap[i];
    if (j < 0) continue;
    pos[j * 3] = positions[i * 3];
    pos[j * 3 + 1] = positions[i * 3 + 1];
    pos[j * 3 + 2] = positions[i * 3 + 2];
  }

  const idx =
    next > 65535 ? new Uint32Array(selected.length * 3) : new Uint16Array(selected.length * 3);
  for (let i = 0; i < selected.length; i++) {
    idx[i * 3] = remap[selected[i].v[0]];
    idx[i * 3 + 1] = remap[selected[i].v[1]];
    idx[i * 3 + 2] = remap[selected[i].v[2]];
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
