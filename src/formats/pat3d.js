import { BinaryReader, assertSaneCounts } from '../io/BinaryReader.js';
import { SIZES, OBJ_FRAME_SEARCH_MAX, FIXED, MAX_OBJECTS } from './constants.js';
import {
  readSmdFileHeader,
  readSmdFileObjInfo,
  readFramePos,
  readMatrix4D,
  readMatrix4F,
} from './smdHeader.js';
import { readMaterialGroup, readTexLink } from './material.js';
import { relinkTexLinks, relinkHierarchy } from './relink.js';

/**
 * `Vertex` — 24 bytes. Position and normal, both 24.8 fixed-point.
 * The normal is frequently all-zero in shipped assets; recompute it.
 * @param {BinaryReader} r
 */
export function readVertex(r) {
  const start = r.offset;
  const x = r.i32() / FIXED;
  const y = r.i32() / FIXED;
  const z = r.i32() / FIXED;
  const nx = r.i32() / FIXED;
  const ny = r.i32() / FIXED;
  const nz = r.i32() / FIXED;
  r.expect(start + SIZES.VERTEX, 'Vertex');
  return { x, y, z, nx, ny, nz };
}

/**
 * `Face` — 36 bytes. Triangle indices, material id, inline UVs and a pointer to
 * the shared TEXLINK array.
 *
 * The inline UVs (`t`) are used as a fallback when `texIndex === -1`. The Java
 * reference emits (0,0) in that case, which collapses the whole triangle onto
 * one texel; using the inline UVs is strictly better and costs nothing.
 * @param {BinaryReader} r
 */
export function readFace(r) {
  const start = r.offset;
  const v = [r.u16(), r.u16(), r.u16()];
  const matId = r.u16();
  const t = [
    [r.f32(), r.f32()],
    [r.f32(), r.f32()],
    [r.f32(), r.f32()],
  ];
  const lpTexLink = r.u32();
  r.expect(start + SIZES.FACE, 'Face');
  return { v, matId, t, lpTexLink, texIndex: -1 };
}

/**
 * `GeomObject` header — 2236 bytes.
 *
 * In a .smd this is a renderable mesh node. In a .smb it is a bone: same
 * structure, but with `nVertex === 0` and only the transform tracks populated.
 * @param {BinaryReader} r
 */
export function readGeomObjectHeader(r) {
  const start = r.offset;

  r.skip(4); // Head, magic "DCB\0"
  r.skip(4); // *Vertex
  r.skip(4); // *Face
  const lpOldTexLink = r.u32();
  const lpPhysique = r.u32();

  const zeroVertex = readVertex(r);

  const maxZ = r.i32(),
    minZ = r.i32();
  const maxY = r.i32(),
    minY = r.i32();
  const maxX = r.i32(),
    minX = r.i32();

  const dBound = r.i32();
  const bound = r.i32();
  const maxVertex = r.i32();
  const maxFace = r.i32();

  const nVertex = r.i32();
  const nFace = r.i32();
  const nTexLink = r.i32();

  const colorEffect = r.i32();
  const clipStates = r.i32();

  const posi = { x: r.i32(), y: r.i32(), z: r.i32() };
  const cameraPosi = { x: r.i32(), y: r.i32(), z: r.i32() };
  const angle = { x: r.i32(), y: r.i32(), z: r.i32() };

  r.skip(32); // Trig[8]

  const nodeName = r.str(32);
  const nodeParent = r.str(32);
  r.skip(4); // *pParent

  const transform = readMatrix4D(r);
  /**
   * The file stores the *inverse* bind matrix here. Inverting it yields the
   * bind TM used to place the vertices; it is also exactly what
   * `THREE.Skeleton` wants as a `boneInverse`.
   */
  const transformInvert = readMatrix4D(r);
  readMatrix4F(r); // transformResult — runtime cache, discarded
  const transformRotate = readMatrix4D(r);
  const worldMatrix = readMatrix4D(r);
  const localMatrix = readMatrix4D(r);

  r.skip(4); // lFrame

  const qx = r.f32(),
    qy = r.f32(),
    qz = r.f32(),
    qw = r.f32();
  const sx = r.i32() / FIXED,
    sy = r.i32() / FIXED,
    sz = r.i32() / FIXED;
  const px = r.i32() / FIXED,
    py = r.i32() / FIXED,
    pz = r.i32() / FIXED;

  r.skip(16); // *TmRot, *TmPos, *TmScale, *TmPrevRot

  const tmRotCnt = r.i32();
  const tmPosCnt = r.i32();
  const tmScaleCnt = r.i32();

  for (let i = 0; i < OBJ_FRAME_SEARCH_MAX * 3; i++) readFramePos(r);
  const tmFrameCnt = r.i32();

  r.expect(start + SIZES.GEOM_OBJECT, 'GeomObject header');

  return {
    lpOldTexLink,
    lpPhysique,
    zeroVertex,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    dBound,
    bound,
    maxVertex,
    maxFace,
    nVertex,
    nFace,
    nTexLink,
    colorEffect,
    clipStates,
    posi,
    cameraPosi,
    angle,
    nodeName,
    nodeParent,
    parentIndex: -1,
    transform,
    transformInvert,
    transformRotate,
    worldMatrix,
    localMatrix,
    // Bind pose, decomposed.
    qx,
    qy,
    qz,
    qw,
    sx,
    sy,
    sz,
    px,
    py,
    pz,
    tmRotCnt,
    tmPosCnt,
    tmScaleCnt,
    tmFrameCnt,
    // Filled by readGeomObjectBody:
    vertices: [],
    faces: [],
    texLinks: [],
    rotTrack: [],
    posTrack: [],
    scaleTrack: [],
    boneNames: null,
    maxFrame: 0,
  };
}

/**
 * Variable-length payload that follows a `GeomObject` header.
 * @param {BinaryReader} r
 * @param {ReturnType<typeof readGeomObjectHeader>} obj
 */
export function readGeomObjectBody(r, obj) {
  assertSaneCounts({
    nVertex: obj.nVertex,
    nFace: obj.nFace,
    nTexLink: obj.nTexLink,
    tmRotCnt: obj.tmRotCnt,
    tmPosCnt: obj.tmPosCnt,
    tmScaleCnt: obj.tmScaleCnt,
  });

  for (let i = 0; i < obj.nVertex; i++) obj.vertices.push(readVertex(r));
  for (let i = 0; i < obj.nFace; i++) obj.faces.push(readFace(r));
  for (let i = 0; i < obj.nTexLink; i++) obj.texLinks.push(readTexLink(r));

  for (let i = 0; i < obj.tmRotCnt; i++) {
    obj.rotTrack.push({ frame: r.i32(), x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() });
  }
  for (let i = 0; i < obj.tmPosCnt; i++) {
    obj.posTrack.push({ frame: r.i32(), x: r.f32(), y: r.f32(), z: r.f32() });
  }
  for (let i = 0; i < obj.tmScaleCnt; i++) {
    obj.scaleTrack.push({
      frame: r.i32(),
      x: r.i32() / FIXED,
      y: r.i32() / FIXED,
      z: r.i32() / FIXED,
    });
  }

  // TmPrevRot: one 64-byte float matrix per rotation key. Runtime cache.
  r.skip(obj.tmRotCnt * SIZES.MATRIX4);

  relinkTexLinks(obj.faces, obj.texLinks, obj.lpOldTexLink);

  // Rigid skin binding: one 32-byte bone name per vertex.
  if (obj.lpPhysique !== 0) {
    obj.boneNames = new Array(obj.nVertex);
    for (let i = 0; i < obj.nVertex; i++) obj.boneNames[i] = r.str(32);
  }

  obj.maxFrame = Math.max(
    obj.rotTrack.length ? obj.rotTrack[obj.rotTrack.length - 1].frame : 0,
    obj.posTrack.length ? obj.posTrack[obj.posTrack.length - 1].frame : 0,
    obj.scaleTrack.length ? obj.scaleTrack[obj.scaleTrack.length - 1].frame : 0,
  );

  return obj;
}

/**
 * Parse a PAT3D file: a model (`.smd`) or a skeleton (`.smb`).
 *
 * Pure data in, pure data out — no three.js. Safe to run in a Web Worker and
 * `structuredClone` the result, because the tree contains no cycles.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{header: object, materialGroup: object|null,
 *   objects: ReturnType<typeof readGeomObjectHeader>[],
 *   nameToIndex: Map<string, number>, maxFrame: number, type: 'pat3d'}}
 */
export function parsePAT3D(buffer) {
  const r = new BinaryReader(buffer);
  const header = readSmdFileHeader(r);

  assertSaneCounts({ objCounter: header.objCounter }, MAX_OBJECTS * 8);

  // Non-0.66 files carry an ObjInfo table here. 0.66 embeds it per object.
  if (!header.isVer066) {
    for (let i = 0; i < header.objCounter; i++) readSmdFileObjInfo(r);
  }

  let materialGroup = null;
  if (header.matCounter > 0) materialGroup = readMaterialGroup(r);

  const objects = [];
  for (let i = 0; i < header.objCounter; i++) {
    if (header.isVer066) readSmdFileObjInfo(r);
    const obj = readGeomObjectHeader(r);
    readGeomObjectBody(r, obj);
    objects.push(obj);
  }

  const nameToIndex = relinkHierarchy(objects);
  const maxFrame = objects.reduce((m, o) => Math.max(m, o.maxFrame), 0);

  return { type: 'pat3d', header, materialGroup, objects, nameToIndex, maxFrame };
}

/** Alias: a `.smb` is the same structure with no materials and no meshes. */
export const parseSMB = parsePAT3D;
