import { SIZES } from './constants.js';
import { assertSaneCounts } from '../io/BinaryReader.js';

/**
 * `TEXLINK` — 32 bytes. One UV triple per triangle, plus a link to the next
 * UV set (the lightmap channel).
 * @param {import('../io/BinaryReader.js').BinaryReader} r
 */
export function readTexLink(r) {
  const start = r.offset;
  const u = [r.f32(), r.f32(), r.f32()];
  const v = [r.f32(), r.f32(), r.f32()];
  r.skip(4); // *hTexture
  const lpNextTex = r.u32();
  r.expect(start + SIZES.TEXLINK, 'TEXLINK');
  return { u, v, lpNextTex, nextIndex: -1 };
}

/**
 * `_Material` — 320 bytes. Fixed-function Direct3D material state.
 * The texture *names* are not here; they follow in a separate block read by
 * `readMaterialGroup`.
 * @param {import('../io/BinaryReader.js').BinaryReader} r
 */
export function readMaterial(r) {
  const start = r.offset;

  const inUse = r.i32();
  const textureCounter = r.i32();
  r.skip(32); // *smTexture[8]
  const textureStageState = Array.from(r.i32Array(8));
  const textureFormState = Array.from(r.i32Array(8));
  const reformTexture = r.i32();
  const mapOpacity = r.i32();
  const textureType = r.i32();
  const blendType = r.i32();
  const shade = r.i32();
  const twoSide = r.i32();
  const serialNum = r.i32();
  const diffuse = { r: r.f32(), g: r.f32(), b: r.f32() };
  const transparency = r.f32();
  const selfIllum = r.f32();
  const textureSwap = r.i32();
  const matFrame = r.i32();
  const textureClip = r.i32();
  const useState = r.i32();
  const meshState = r.i32();
  const windMeshBottom = r.i32();
  r.skip(128); // *smAnimTexture[32]
  const animTexCounter = r.i32();
  const frameMask = r.i32();
  const shiftFrameSpeed = r.i32();
  const animationFrame = r.i32();

  r.expect(start + SIZES.MATERIAL, '_Material');

  return {
    inUse,
    textureCounter,
    textureStageState,
    textureFormState,
    reformTexture,
    mapOpacity,
    textureType,
    blendType,
    shade,
    twoSide,
    serialNum,
    diffuse,
    transparency,
    selfIllum,
    textureSwap,
    matFrame,
    textureClip,
    useState,
    meshState,
    windMeshBottom,
    animTexCounter,
    frameMask,
    shiftFrameSpeed,
    animationFrame,
    /** Static textures. [0] is diffuse, [1] is the lightmap. */
    textures: [],
    /** Flipbook frames, when `textureType === 1`. */
    animTextures: [],
  };
}

/**
 * `MaterialGroup` — 88 bytes of header, then `materialCount` x `_Material`,
 * each optionally followed by its texture-name block.
 *
 * The name block exists only when `inUse !== 0`, and is laid out as:
 *   i32 strLen                      (total size of the block; read and ignored)
 *   textureCounter x (cstr Name, cstr NameA)
 *   animTexCounter x (cstr Name, cstr NameA)
 *
 * @param {import('../io/BinaryReader.js').BinaryReader} r
 */
export function readMaterialGroup(r) {
  const start = r.offset;

  r.skip(4); // Head
  r.skip(4); // *smMaterial
  const materialCount = r.i32();
  const reformTexture = r.i32();
  const maxMaterial = r.i32();
  const lastSearchMaterial = r.i32();
  const lastSearchName = r.str(64);

  r.expect(start + SIZES.MATERIAL_GROUP, 'MaterialGroup');

  if (materialCount < 0) {
    return {
      materialCount: 0,
      materials: [],
      reformTexture,
      maxMaterial,
      lastSearchMaterial,
      lastSearchName,
    };
  }
  assertSaneCounts({ materialCount }, 4096);

  const materials = [];
  for (let i = 0; i < materialCount; i++) {
    const m = readMaterial(r);

    if (m.inUse !== 0) {
      r.skip(4); // int strLen — total bytes of the name block that follows

      assertSaneCounts({ textureCounter: m.textureCounter, animTexCounter: m.animTexCounter }, 256);

      for (let j = 0; j < m.textureCounter; j++) {
        m.textures.push({ name: r.cstr(), nameAlpha: r.cstr() });
      }
      for (let j = 0; j < m.animTexCounter; j++) {
        m.animTextures.push({ name: r.cstr(), nameAlpha: r.cstr() });
      }
    }

    materials.push(m);
  }

  return {
    materialCount,
    materials,
    reformTexture,
    maxMaterial,
    lastSearchMaterial,
    lastSearchName,
  };
}
