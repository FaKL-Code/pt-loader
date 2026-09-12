import {
  SIZES,
  OBJ_FRAME_SEARCH_MAX,
  INX_SIZE_CLASSIC,
  MOTION_INFO_MAX,
  TALK_MOTION_INFO_MAX,
  TALK_MOTION_FILE_MAX,
  NPC_MOTION_INFO_MAX,
} from '../../src/formats/constants.js';

/** Minimal little-endian writer used to synthesise fixtures. */
export class W {
  constructor(capacity = 1 << 20) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
    this.u8 = new Uint8Array(this.buf);
    this.p = 0;
  }
  i32(v) {
    this.view.setInt32(this.p, v, true);
    this.p += 4;
    return this;
  }
  u32(v) {
    this.view.setUint32(this.p, v >>> 0, true);
    this.p += 4;
    return this;
  }
  i16(v) {
    this.view.setInt16(this.p, v, true);
    this.p += 2;
    return this;
  }
  u16(v) {
    this.view.setUint16(this.p, v, true);
    this.p += 2;
    return this;
  }
  f32(v) {
    this.view.setFloat32(this.p, v, true);
    this.p += 4;
    return this;
  }
  byte(v) {
    this.u8[this.p++] = v;
    return this;
  }
  zeros(n) {
    this.p += n;
    return this;
  }
  /** Fixed-width NUL-terminated field. */
  str(s, size) {
    for (let i = 0; i < s.length && i < size - 1; i++) this.u8[this.p + i] = s.charCodeAt(i);
    this.p += size;
    return this;
  }
  /** NUL-terminated string of unbounded length. */
  cstr(s) {
    for (let i = 0; i < s.length; i++) this.u8[this.p++] = s.charCodeAt(i);
    this.u8[this.p++] = 0;
    return this;
  }
  at(offset) {
    this.p = offset;
    return this;
  }
  toArrayBuffer() {
    return this.buf.slice(0, this.p);
  }
}

/** `SmdFileHeader` — exactly 556 bytes. */
export function writeSmdHeader(
  w,
  { version = 'SMD Ver 0.70', objCounter = 1, matCounter = 1 } = {},
) {
  const start = w.p;
  w.str(version, 24);
  w.i32(objCounter);
  w.i32(matCounter);
  w.i32(0); // matFilePoint
  w.i32(0); // firstObjInfoPoint
  w.i32(0); // tmFrameCounter
  w.zeros(OBJ_FRAME_SEARCH_MAX * SIZES.FRAME_POS);
  if (w.p - start !== SIZES.SMD_FILE_HEADER) throw new Error('fixture: bad SmdFileHeader size');
  return w;
}

/** `SmdFileObjInfo` — 40 bytes. */
export function writeObjInfo(w, name = 'obj0') {
  const start = w.p;
  w.str(name, 32).i32(0).i32(0);
  if (w.p - start !== SIZES.SMD_FILE_OBJ_INFO) throw new Error('fixture: bad SmdFileObjInfo size');
  return w;
}

/** `_Material` — exactly 320 bytes. */
export function writeMaterial(w, o = {}) {
  const start = w.p;
  const {
    inUse = 1,
    textureCounter = 1,
    textureFormState = [0, 0, 0, 0, 0, 0, 0, 0],
    mapOpacity = 0,
    textureType = 0,
    blendType = 0,
    twoSide = 0,
    diffuse = [1, 1, 1],
    transparency = 0,
    selfIllum = 0,
    useState = 0,
    meshState = 1,
    windMeshBottom = 0,
    animTexCounter = 0,
    shiftFrameSpeed = 6,
  } = o;

  w.i32(inUse);
  w.i32(textureCounter);
  w.zeros(32); // *smTexture[8]
  w.zeros(32); // TextureStageState[8]
  for (let i = 0; i < 8; i++) w.i32(textureFormState[i] ?? 0);
  w.i32(0); // ReformTexture
  w.i32(mapOpacity);
  w.i32(textureType);
  w.i32(blendType);
  w.i32(0); // Shade
  w.i32(twoSide);
  w.i32(7); // SerialNum
  w.f32(diffuse[0]).f32(diffuse[1]).f32(diffuse[2]);
  w.f32(transparency);
  w.f32(selfIllum);
  w.i32(0).i32(0).i32(0); // TextureSwap, MatFrame, TextureClip
  w.i32(useState);
  w.i32(meshState);
  w.i32(windMeshBottom);
  w.zeros(128); // *smAnimTexture[32]
  w.i32(animTexCounter);
  w.i32(Math.max(0, animTexCounter - 1));
  w.i32(shiftFrameSpeed);
  w.i32(0); // AnimationFrame

  if (w.p - start !== SIZES.MATERIAL) throw new Error(`fixture: bad _Material size ${w.p - start}`);
  return w;
}

/** `MaterialGroup` header (88 bytes) plus its materials and name blocks. */
export function writeMaterialGroup(w, materials = [{ textureNames: ['test.bmp'] }]) {
  const start = w.p;
  w.i32(0); // Head
  w.i32(0); // *smMaterial
  w.i32(materials.length);
  w.i32(0).i32(0).i32(0);
  w.str('', 64);
  if (w.p - start !== SIZES.MATERIAL_GROUP) throw new Error('fixture: bad MaterialGroup size');

  for (const m of materials) {
    const names = m.textureNames ?? [];
    const animNames = m.animTextureNames ?? [];
    writeMaterial(w, { ...m, textureCounter: names.length, animTexCounter: animNames.length });
    if ((m.inUse ?? 1) !== 0) {
      w.i32(0); // strLen (read and ignored)
      for (const n of names) w.cstr(n).cstr('');
      for (const n of animNames) w.cstr(n).cstr('');
    }
  }
  return w;
}

/** Identity `Matrix4D`: 24.8 fixed point, so the diagonal is 256. */
export function writeIdentityMatrix4D(w) {
  const m = [256, 0, 0, 0, 0, 256, 0, 0, 0, 0, 256, 0, 0, 0, 0, 256];
  for (const v of m) w.i32(v);
  return w;
}

/** `GeomObject` header — exactly 2236 bytes. */
export function writeGeomObject(w, o = {}) {
  const start = w.p;
  const {
    nodeName = 'obj0',
    nodeParent = '',
    nVertex = 3,
    nFace = 1,
    nTexLink = 1,
    texLinkBase = 0x1000,
    physique = 0,
    tmRotCnt = 0,
    tmPosCnt = 0,
    tmScaleCnt = 0,
    q = [0, 0, 0, 1],
    s = [256, 256, 256],
    p = [0, 0, 0],
  } = o;

  w.u32(0x004243440); // Head
  w.u32(0); // *Vertex
  w.u32(0); // *Face
  w.u32(texLinkBase); // *TexLink — relink anchor
  w.u32(physique); // *Physique

  w.zeros(SIZES.VERTEX); // zeroVertex
  for (let i = 0; i < 6; i++) w.i32(0); // bounds
  w.i32(0).i32(0); // dBound, Bound
  w.i32(nVertex).i32(nFace); // MaxVertex, MaxFace
  w.i32(nVertex).i32(nFace);
  w.i32(nTexLink);
  w.i32(0).i32(0); // ColorEffect, ClipStates
  w.zeros(36); // Posi, CameraPosi, Angle
  w.zeros(32); // Trig[8]
  w.str(nodeName, 32);
  w.str(nodeParent, 32);
  w.u32(0); // *pParent

  writeIdentityMatrix4D(w); // transform
  writeIdentityMatrix4D(w); // transformInvert
  w.zeros(SIZES.MATRIX4); // transformResult (floats)
  writeIdentityMatrix4D(w); // transformRotate
  writeIdentityMatrix4D(w); // worldMatrix
  writeIdentityMatrix4D(w); // localMatrix

  w.i32(0); // lFrame
  w.f32(q[0]).f32(q[1]).f32(q[2]).f32(q[3]);
  w.i32(s[0]).i32(s[1]).i32(s[2]);
  w.i32(p[0]).i32(p[1]).i32(p[2]);
  w.zeros(16); // 4 pointers
  w.i32(tmRotCnt).i32(tmPosCnt).i32(tmScaleCnt);
  w.zeros(OBJ_FRAME_SEARCH_MAX * SIZES.FRAME_POS * 3);
  w.i32(0); // TmFrameCnt

  if (w.p - start !== SIZES.GEOM_OBJECT) {
    throw new Error(`fixture: bad GeomObject size ${w.p - start}`);
  }
  return w;
}

/** A complete, minimal, valid PAT3D file: one object, one triangle, one material. */
export function buildPAT3D({ version = 'SMD Ver 0.70', physique = 0, boneNames = null } = {}) {
  const w = new W();
  const is066 = version.includes('0.66');

  writeSmdHeader(w, { version, objCounter: 1, matCounter: 1 });
  if (!is066) writeObjInfo(w, 'obj0');
  writeMaterialGroup(w, [{ textureNames: ['test.bmp'] }]);
  if (is066) writeObjInfo(w, 'obj0');

  const texLinkBase = 0x1000;
  writeGeomObject(w, { texLinkBase, physique });

  // vertices (24.8 fixed point)
  const verts = [
    [0, 0, 0],
    [256, 0, 0],
    [0, 256, 0],
  ];
  for (const [x, y, z] of verts) {
    w.i32(x).i32(y).i32(z);
    w.i32(0).i32(256).i32(0); // normal
  }

  // one face using material 0, pointing at TexLink[0]
  w.u16(0).u16(1).u16(2).u16(0);
  for (let i = 0; i < 3; i++) w.f32(0.25).f32(0.75);
  w.u32(texLinkBase);

  // one TexLink, no second UV set
  w.f32(0).f32(1).f32(0);
  w.f32(0).f32(0).f32(1);
  w.u32(0); // *hTexture
  w.u32(0); // *NextTex

  if (physique !== 0) {
    for (const n of boneNames ?? ['Bip01', 'Bip01', 'Bip01']) w.str(n, 32);
  }

  return w.toArrayBuffer();
}

/**
 * A minimal `.smb` skeleton: no materials, no geometry, one bone chain with
 * rotation keyframes. Used to exercise the delta-accumulation logic.
 *
 * @param {{name:string, parent?:string, rot?:{frame:number,x:number,y:number,z:number,w:number}[],
 *          pos?:{frame:number,x:number,y:number,z:number}[], q?:number[], p?:number[]}[]} bones
 */
export function buildSMB(bones) {
  const w = new W();
  writeSmdHeader(w, { version: 'SMD Ver 0.70', objCounter: bones.length, matCounter: 0 });
  for (const b of bones) writeObjInfo(w, b.name);

  for (const b of bones) {
    const rot = b.rot ?? [];
    const pos = b.pos ?? [];
    writeGeomObject(w, {
      nodeName: b.name,
      nodeParent: b.parent ?? '',
      nVertex: 0,
      nFace: 0,
      nTexLink: 0,
      tmRotCnt: rot.length,
      tmPosCnt: pos.length,
      tmScaleCnt: 0,
      q: b.q ?? [0, 0, 0, 1],
      p: (b.p ?? [0, 0, 0]).map((v) => Math.round(v * 256)),
    });

    for (const k of rot) w.i32(k.frame).f32(k.x).f32(k.y).f32(k.z).f32(k.w);
    for (const k of pos) w.i32(k.frame).f32(k.x).f32(k.y).f32(k.z);
    w.zeros(rot.length * SIZES.MATRIX4); // TmPrevRot
  }

  return w.toArrayBuffer();
}

/** A complete, minimal, valid STAGE3D file. */
export function buildSTAGE3D() {
  const w = new W(1 << 20);
  writeSmdHeader(w, { version: 'SMD Ver 0.70', objCounter: 0, matCounter: 1 });

  const stageStart = w.p;
  const texLinkBase = 0x2000;

  w.i32(0); // Head
  w.zeros(SIZES.STAGE_AREA);
  w.u32(0); // *AreaList
  w.i32(0).i32(0).i32(0).i32(0); // AreaListCnt, MemMode, SumCount, CalcSumCount
  w.u32(0).u32(0); // *Vertex, *Face
  w.u32(texLinkBase); // *TexLink
  w.u32(0).u32(0).u32(0).u32(0); // *Light, *MaterialGroup, *StageObject, *Material
  w.i32(3).i32(1).i32(1).i32(1); // nVertex, nFace, nTexLink, nLight
  w.i32(0).i32(0).i32(0); // nVertColor, Contrast, Bright
  w.i32(0).i32(-256).i32(0); // vectLight
  w.u32(0).i32(0); // *lpwAreaBuff, wAreaSize
  w.i32(-1000).i32(-1000).i32(1000).i32(1000); // rect

  if (w.p - stageStart !== SIZES.STAGE) {
    throw new Error(`fixture: bad Stage size ${w.p - stageStart}`);
  }

  writeMaterialGroup(w, [{ textureNames: ['ground.bmp', 'light.bmp'] }]);

  // 3 StageVertex: file order is (-z, y, -x)
  const verts = [
    [0, 0, 0],
    [0, 0, 256],
    [256, 0, 0],
  ];
  for (const [a, b, c] of verts) {
    w.i32(0).u32(0); // sum, *lpRendVertex
    w.i32(a).i32(b).i32(c);
    w.i16(256).i16(256).i16(256).i16(256); // colour
  }

  // 1 StageFace
  w.i32(0).i32(0);
  w.u16(0).u16(1).u16(2).u16(0);
  w.u32(texLinkBase);
  w.i16(0).i16(32767).i16(0).i16(0); // normal

  // 1 TEXLINK
  w.f32(0).f32(1).f32(0);
  w.f32(0).f32(0).f32(1);
  w.u32(0).u32(0);

  // 1 Light3D
  w.i32(1);
  w.i32(0).i32(256).i32(0);
  w.i32(65536); // range
  w.u16(255).u16(128).u16(64);

  return w.toArrayBuffer();
}

/** `MotionInfo` — 120 bytes (classic). */
function writeMotionInfo(w, { state = 0, startTick = 0, endTick = 0 } = {}) {
  const start = w.p;
  w.i32(state);
  w.i32(startTick * 256); // motionStartFrame, 24.8 fixed point
  w.i32(0); // talkStartFrame
  w.i32(0); // MotionKeyWord_2
  w.i32(endTick * 256); // endFrame
  w.i32(0).i32(0).i32(0).i32(0); // EventFrame[4]
  w.i32(0); // ItemCodeCount
  w.zeros(52); // ItemCodeList
  w.i32(0); // dwJobCodeBit
  w.zeros(8); // SkillCodeList
  w.i32(0); // MapPosition
  w.i32(0); // Repeat
  w.u16(0).u16(0); // KeyCode + padding
  w.i32(0); // MotionFrame
  if (w.p - start !== SIZES.MOTION_INFO)
    throw new Error(`fixture: bad MotionInfo size ${w.p - start}`);
  return w;
}

/** A complete classic-variant `.inx`, exactly 67084 bytes. */
export function buildINX({ motions = [{ state: 0x040, startTick: 10, endTick: 70 }] } = {}) {
  const w = new W(1 << 18);

  w.str('hero.smd', 64);
  w.str('hero.smb', 64);
  w.str('', 64);

  for (let g = 0; g < 3; g++) {
    w.i32(1);
    for (let i = 0; i < 4; i++) w.str(i === 0 ? 'hero_h' : '', 16);
  }

  for (let i = 0; i < MOTION_INFO_MAX; i++) writeMotionInfo(w, motions[i] ?? {});

  w.i16(motions.length).u16(0);
  w.i32(0).i32(0);
  w.str('', 64); // motionLinkFile
  w.str('', 64); // talkLinkFile
  w.str('', 64); // talkMotionFile

  for (let i = 0; i < TALK_MOTION_INFO_MAX; i++) writeMotionInfo(w, {});
  w.i32(0); // talkMotionCount

  for (let i = 0; i < NPC_MOTION_INFO_MAX; i++) w.i32(0);
  for (let i = 0; i < 100; i++) w.i32(0);
  for (let i = 0; i < TALK_MOTION_INFO_MAX; i++) w.i32(0);
  for (let f = 0; f < TALK_MOTION_FILE_MAX; f++) for (let i = 0; i < 100; i++) w.i32(0);

  if (w.p !== INX_SIZE_CLASSIC)
    throw new Error(`fixture: .inx is ${w.p} bytes, expected ${INX_SIZE_CLASSIC}`);
  return w.toArrayBuffer();
}

/** A 24-bit uncompressed BMP with the given bottom-up RGB rows. */
export function buildBMP(width, height, rowsBottomUp) {
  const stride = ((24 * width + 31) >> 5) * 4;
  const dataSize = stride * height;
  const w = new W(54 + dataSize);

  w.byte(0x42).byte(0x4d);
  w.u32(54 + dataSize);
  w.u32(0);
  w.u32(54);
  w.u32(40);
  w.i32(width);
  w.i32(height);
  w.u16(1);
  w.u16(24);
  w.u32(0);
  w.u32(dataSize);
  w.i32(2835).i32(2835);
  w.u32(0).u32(0);

  for (let y = 0; y < height; y++) {
    const rowStart = w.p;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rowsBottomUp[y][x];
      w.byte(b).byte(g).byte(r);
    }
    w.p = rowStart + stride;
  }
  return w.toArrayBuffer();
}

/** An uncompressed 24-bit TGA, bottom-up (origin bit clear). */
export function buildTGA(width, height, rowsBottomUp) {
  const w = new W(18 + width * height * 3);
  w.byte(0).byte(0).byte(2);
  w.u16(0).u16(0).byte(0);
  w.u16(0).u16(0);
  w.u16(width).u16(height);
  w.byte(24).byte(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rowsBottomUp[y][x];
      w.byte(b).byte(g).byte(r);
    }
  }
  return w.toArrayBuffer();
}
