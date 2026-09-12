import { SIZES } from './constants.js';

/**
 * Resolve the serialized 32-bit pointers into array indices.
 *
 * UVs do not live on the faces — they live in a separate contiguous `TEXLINK`
 * array, and faces reference it by the memory address it had in 2001. Because
 * the array was written contiguously and `sizeof(TEXLINK) === 32`, the index is
 * pure arithmetic against the base address recorded in the owning header:
 *
 *     index = (pointer - base) / 32
 *
 * This parser stores **indices**, never object references: `face.texIndex` and
 * `texLink.nextIndex`, both `-1` when absent. That keeps the parsed tree free of
 * cycles, which makes it cheap to `structuredClone` across a Web Worker and
 * trivial to serialize to JSON.
 *
 * @param {{lpTexLink: number, texIndex: number}[]} faces
 * @param {{lpNextTex: number, nextIndex: number}[]} texLinks
 * @param {number} base value of the `*TexLink` pointer field in the header
 */
export function relinkTexLinks(faces, texLinks, base) {
  const count = texLinks.length;

  const toIndex = (ptr) => {
    if (ptr === 0) return -1;
    // Both operands come from `u32()`, so the subtraction is exact even when
    // the high bit is set. Mixing i32 and u32 here produces absurd indices.
    const delta = ptr - base;
    if (delta < 0 || delta % SIZES.TEXLINK !== 0) return -1;
    const i = delta / SIZES.TEXLINK;
    return i >= 0 && i < count ? i : -1;
  };

  for (const tl of texLinks) tl.nextIndex = toIndex(tl.lpNextTex);
  for (const f of faces) f.texIndex = toIndex(f.lpTexLink);
}

/**
 * Resolve `NodeParent` -> `NodeName` into `parentIndex`.
 *
 * Bone and object hierarchy is referenced by name, not by pointer, so this is a
 * plain map lookup. Objects whose parent is missing or empty become roots
 * (`parentIndex === -1`).
 *
 * @param {{nodeName: string, nodeParent: string, parentIndex: number}[]} objects
 */
export function relinkHierarchy(objects) {
  const byName = new Map();
  objects.forEach((o, i) => {
    if (o.nodeName) byName.set(o.nodeName, i);
  });
  for (const o of objects) {
    const i = o.nodeParent ? byName.get(o.nodeParent) : undefined;
    o.parentIndex = i === undefined ? -1 : i;
  }
  return byName;
}

/**
 * Resolve per-vertex bone names into indices into the skeleton's object array.
 * Unmatched names become `-1`; the build layer falls back to the object's own
 * transform for those vertices.
 *
 * @param {string[]} boneNames per-vertex bone name, length === nVertex
 * @param {Map<string, number>} skeletonIndex name -> index, from `relinkHierarchy`
 * @returns {Int32Array}
 */
export function resolveBoneIndices(boneNames, skeletonIndex) {
  const out = new Int32Array(boneNames.length);
  for (let i = 0; i < boneNames.length; i++) {
    const idx = skeletonIndex.get(boneNames[i]);
    out[i] = idx === undefined ? -1 : idx;
  }
  return out;
}
