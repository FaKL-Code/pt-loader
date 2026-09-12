import { BinaryReader, assertSaneCounts } from '../io/BinaryReader.js';
import { SIZES, FIXED } from './constants.js';
import { readSmdFileHeader } from './smdHeader.js';
import { readMaterialGroup, readTexLink } from './material.js';
import { relinkTexLinks } from './relink.js';

/**
 * `StageVertex` — 28 bytes.
 *
 * The three position integers are **not** x, y, z in read order. The engine
 * maps them as `(-third, second, -first)` to convert from the game's
 * left-handed Direct3D space. The two negations preserve triangle winding, so
 * index order must be left alone.
 * @param {BinaryReader} r
 */
export function readStageVertex(r) {
  const start = r.offset;
  r.skip(4); // sum
  r.skip(4); // *lpRendVertex

  const a = r.i32();
  const b = r.i32();
  const c = r.i32();
  const z = -a / FIXED;
  const y = b / FIXED;
  const x = -c / FIXED;

  const cr = r.i16() / FIXED;
  const cg = r.i16() / FIXED;
  const cb = r.i16() / FIXED;
  const ca = r.i16() / FIXED;

  r.expect(start + SIZES.STAGE_VERTEX, 'StageVertex');
  return { x, y, z, r: cr, g: cg, b: cb, a: ca };
}

/**
 * `StageFace` — 28 bytes. No inline UVs; the TEXLINK pointer is the only
 * source of texture coordinates.
 * @param {BinaryReader} r
 */
export function readStageFace(r) {
  const start = r.offset;
  r.skip(4); // sum
  r.skip(4); // CalcSum
  const v = [r.u16(), r.u16(), r.u16()];
  const matId = r.u16();
  const lpTexLink = r.u32();
  const nx = r.i16() / 32767;
  const ny = r.i16() / 32767;
  const nz = r.i16() / 32767;
  r.skip(2); // Y — unused angle term
  r.expect(start + SIZES.STAGE_FACE, 'StageFace');
  return { v, matId, lpTexLink, texIndex: -1, nx, ny, nz };
}

/**
 * `Light3D` — 26 bytes.
 *
 * Note: the Java source comments this struct as 22 bytes, but the read
 * sequence consumes 26 (4 + 12 + 4 + 6). Trust the sequence, not the comment.
 * @param {BinaryReader} r
 */
export function readLight3D(r) {
  const start = r.offset;
  const type = r.i32();

  const a = r.i32();
  const b = r.i32();
  const c = r.i32();
  const z = -a / FIXED;
  const y = b / FIXED;
  const x = -c / FIXED;

  const range = r.i32() / FIXED / FIXED;
  const cr = r.u16() / 255;
  const cg = r.u16() / 255;
  const cb = r.u16() / 255;

  r.expect(start + SIZES.LIGHT3D, 'Light3D');
  return { type, x, y, z, range, r: cr, g: cg, b: cb };
}

/**
 * Parse a STAGE3D map file.
 *
 * 262,144 of the 262,260 bytes of the `Stage` struct are a 256x256 spatial
 * acceleration grid of dead pointers, skipped wholesale. That is why every map
 * file is at least 262 KB.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 */
export function parseSTAGE3D(buffer) {
  const r = new BinaryReader(buffer);
  const header = readSmdFileHeader(r);

  const stageStart = r.offset;

  r.skip(4); // Head
  r.skip(SIZES.STAGE_AREA); // WORD *StageArea[256][256]
  r.skip(4); // *AreaList
  const areaListCnt = r.i32();
  const memMode = r.i32();
  const sumCount = r.i32();
  const calcSumCount = r.i32();

  r.skip(4); // *Vertex
  r.skip(4); // *Face
  const lpOldTexLink = r.u32(); // *TexLink — relink anchor
  r.skip(4); // *smLight
  r.skip(4); // *smMaterialGroup
  r.skip(4); // *StageObject
  r.skip(4); // *smMaterial

  const nVertex = r.i32();
  const nFace = r.i32();
  const nTexLink = r.i32();
  const nLight = r.i32();

  const nVertColor = r.i32();
  const contrast = r.i32();
  const bright = r.i32();

  const lightDir = { x: r.i32(), y: r.i32(), z: r.i32() };

  r.skip(4); // *lpwAreaBuff
  const wAreaSize = r.i32();

  // Map extents on the XZ plane, scaled by 256.
  const left = r.i32();
  const top = r.i32();
  const right = r.i32();
  const bottom = r.i32();

  r.expect(stageStart + SIZES.STAGE, 'Stage');

  assertSaneCounts({ nVertex, nFace, nTexLink, nLight }, 4_000_000);

  let materialGroup = null;
  if (header.matCounter > 0) materialGroup = readMaterialGroup(r);

  const vertices = [];
  for (let i = 0; i < nVertex; i++) vertices.push(readStageVertex(r));

  const faces = [];
  for (let i = 0; i < nFace; i++) faces.push(readStageFace(r));

  const texLinks = [];
  for (let i = 0; i < nTexLink; i++) texLinks.push(readTexLink(r));

  const lights = [];
  for (let i = 0; i < nLight; i++) lights.push(readLight3D(r));

  relinkTexLinks(faces, texLinks, lpOldTexLink);

  return {
    type: 'stage3d',
    header,
    materialGroup,
    vertices,
    faces,
    texLinks,
    lights,
    nVertColor,
    contrast,
    bright,
    lightDir,
    rect: { left, top, right, bottom },
    areaListCnt,
    memMode,
    sumCount,
    calcSumCount,
    wAreaSize,
  };
}
