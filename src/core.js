/**
 * `@fakl-code/pt-loader/core` — the binary parsers and image decoders, with **no
 * three.js dependency**.
 *
 * Use this entry point when you need the data but not the scene graph:
 *   - inside a Web Worker
 *   - in Node, for an offline glTF/GLB conversion pipeline
 *   - in tests
 *
 * Every parser takes an `ArrayBuffer` (or `Uint8Array`) and returns plain
 * JavaScript objects with no cycles, so results can be `structuredClone`d
 * across a worker boundary or serialised to JSON directly.
 */

export { BinaryReader, assertSaneCounts, assertRemaining } from './io/BinaryReader.js';

export {
  decryptImage,
  decryptBMP,
  decryptTGA,
  encryptBMP,
  encryptTGA,
  isEncryptedBMP,
  isEncryptedTGA,
  isPlainBMP,
  BMP_HEADER_BYTES,
  TGA_HEADER_BYTES,
} from './io/crypto.js';

export * from './formats/constants.js';

export {
  readSmdFileHeader,
  readSmdFileObjInfo,
  readFramePos,
  readMatrix4D,
  readMatrix4F,
} from './formats/smdHeader.js';

export { readMaterial, readMaterialGroup, readTexLink } from './formats/material.js';

export { relinkTexLinks, relinkHierarchy, resolveBoneIndices } from './formats/relink.js';

export {
  parsePAT3D,
  parseSMB,
  readVertex,
  readFace,
  readGeomObjectHeader,
  readGeomObjectBody,
} from './formats/pat3d.js';

export { parseSTAGE3D, readStageVertex, readStageFace, readLight3D } from './formats/stage3d.js';

export { parseINX, readMotionInfo, readModelGroup } from './formats/inx.js';

export { decodeBMP } from './textures/bmp.js';
export { decodeTGA } from './textures/tga.js';
export { decodeImage } from './textures/decode.js';

export {
  resolveAssetPath,
  isSafeAssetPath,
  assertSafeAssetPath,
  dirOf,
  baseOf,
  stripExt,
  changeExt,
} from './util/paths.js';
