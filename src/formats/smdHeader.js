import { SIZES, OBJ_FRAME_SEARCH_MAX } from './constants.js';

/**
 * `FRAME_POS` — 16 bytes. A frame-range search index used by the original
 * engine to seek inside an animation. Not needed for playback.
 * @param {import('../io/BinaryReader.js').BinaryReader} r
 */
export function readFramePos(r) {
  return {
    startFrame: r.i32(),
    endFrame: r.i32(),
    posNum: r.i32(),
    posCnt: r.i32(),
  };
}

/**
 * `SmdFileHeader` — 556 bytes. The first structure of every .smd and .smb.
 *
 * @param {import('../io/BinaryReader.js').BinaryReader} r
 * @returns {{header: string, objCounter: number, matCounter: number,
 *   matFilePoint: number, firstObjInfoPoint: number, tmFrameCounter: number,
 *   tmFrame: object[], isVer066: boolean}}
 */
export function readSmdFileHeader(r) {
  const start = r.offset;

  const header = r.str(24);
  const objCounter = r.i32();
  const matCounter = r.i32();
  const matFilePoint = r.i32();
  const firstObjInfoPoint = r.i32();
  const tmFrameCounter = r.i32();

  const tmFrame = [];
  for (let i = 0; i < OBJ_FRAME_SEARCH_MAX; i++) tmFrame.push(readFramePos(r));

  r.expect(start + SIZES.SMD_FILE_HEADER, 'SmdFileHeader');

  return {
    header,
    objCounter,
    matCounter,
    matFilePoint,
    firstObjInfoPoint,
    tmFrameCounter,
    tmFrame,
    /**
     * Version 0.66 files move the per-object ObjInfo block: instead of a table
     * between the header and the MaterialGroup, the 40 bytes sit immediately
     * before each GeomObject. Getting this wrong shifts the stream by 40 bytes
     * per object and corrupts everything downstream.
     */
    isVer066: header.includes('0.66'),
  };
}

/**
 * `SmdFileObjInfo` — 40 bytes.
 * @param {import('../io/BinaryReader.js').BinaryReader} r
 */
export function readSmdFileObjInfo(r) {
  const start = r.offset;
  const nodeName = r.str(32);
  const length = r.i32();
  const objFilePoint = r.i32();
  r.expect(start + SIZES.SMD_FILE_OBJ_INFO, 'SmdFileObjInfo');
  return { nodeName, length, objFilePoint };
}

/**
 * `Matrix4D` — 64 bytes of 24.8 fixed-point integers, stored row-major in
 * Direct3D order (`_11 _12 _13 _14 _21 ...`).
 *
 * Returned as a 16-element Float64Array **in file order**, already divided by
 * 256. The transpose into a column-vector matrix happens in the build layer
 * (see `build/math.js`), which keeps this module free of three.js.
 *
 * @param {import('../io/BinaryReader.js').BinaryReader} r
 * @returns {Float64Array}
 */
export function readMatrix4D(r) {
  const out = new Float64Array(16);
  for (let i = 0; i < 16; i++) out[i] = r.i32() / 256;
  return out;
}

/**
 * `Matrix4F` — 64 bytes of raw floats. Runtime cache in the original engine;
 * read and discarded.
 * @param {import('../io/BinaryReader.js').BinaryReader} r
 */
export function readMatrix4F(r) {
  const out = new Float64Array(16);
  for (let i = 0; i < 16; i++) out[i] = r.f32();
  return out;
}
