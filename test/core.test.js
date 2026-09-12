import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BinaryReader } from '../src/io/BinaryReader.js';
import {
  decryptBMP,
  encryptBMP,
  decryptTGA,
  encryptTGA,
  isEncryptedBMP,
  isEncryptedTGA,
} from '../src/io/crypto.js';
import { parsePAT3D } from '../src/formats/pat3d.js';
import { parseSTAGE3D } from '../src/formats/stage3d.js';
import { parseINX } from '../src/formats/inx.js';
import { decodeBMP } from '../src/textures/bmp.js';
import { decodeTGA } from '../src/textures/tga.js';
import { decodeImage } from '../src/textures/decode.js';
import { SIZES, INX_SIZE_CLASSIC, FRAMES_PER_TICK } from '../src/formats/constants.js';
import { resolveAssetPath, changeExt, dirOf, baseOf, stripExt } from '../src/util/paths.js';

import { buildPAT3D, buildSTAGE3D, buildINX, buildBMP, buildTGA, W } from './helpers/write.js';

// ---------------------------------------------------------- BinaryReader ---

test('BinaryReader: fixed-width strings consume the whole field', () => {
  const w = new W(64);
  w.str('abc', 32).i32(0x11223344);
  const r = new BinaryReader(w.toArrayBuffer());

  assert.equal(r.str(32), 'abc');
  assert.equal(r.offset, 32, 'the NUL padding must be consumed');
  assert.equal(r.i32(), 0x11223344, 'the next field must still be aligned');
});

test('BinaryReader: a full field with no NUL still consumes exactly `size`', () => {
  const w = new W(16);
  for (let i = 0; i < 4; i++) w.byte(0x41);
  w.i32(7);
  const r = new BinaryReader(w.toArrayBuffer());
  assert.equal(r.str(4), 'AAAA');
  assert.equal(r.i32(), 7);
});

test('BinaryReader: reading past the end throws instead of returning garbage', () => {
  const r = new BinaryReader(new ArrayBuffer(2));
  assert.throws(() => r.i32(), /exceeds buffer/);
});

test('BinaryReader: expect() reports the drift direction', () => {
  const r = new BinaryReader(new ArrayBuffer(16));
  r.skip(8);
  assert.throws(() => r.expect(12, 'Thing'), /Thing ended at offset 8, expected 12/);
});

// ----------------------------------------------------------------- crypto ---

test('crypto: BMP header obfuscation round-trips', () => {
  const original = new Uint8Array(20).map((_, i) => (i * 37) & 0xff);
  original[0] = 0x42;
  original[1] = 0x4d;

  const copy = original.slice();
  encryptBMP(copy);
  assert.ok(isEncryptedBMP(copy), 'encrypted BMP starts with 41 38');
  assert.notDeepEqual(copy.slice(0, 14), original.slice(0, 14));

  decryptBMP(copy);
  assert.deepEqual(copy, original);
});

test('crypto: TGA header obfuscation round-trips', () => {
  const original = new Uint8Array(24).map((_, i) => (i * 91) & 0xff);
  original[0] = 0;
  original[1] = 0;

  const copy = original.slice();
  encryptTGA(copy);
  assert.ok(isEncryptedTGA(copy));
  decryptTGA(copy);
  assert.deepEqual(copy, original);
});

test('crypto: decryption matches the i*i formula byte for byte', () => {
  // The Java reference casts i*i to a byte first; modulo-256 arithmetic makes
  // that cast irrelevant, and this pins the equivalence.
  const encrypted = new Uint8Array(18);
  encrypted[0] = 0x47;
  encrypted[1] = 0x38;
  for (let i = 2; i < 18; i++) encrypted[i] = (100 + i * i) & 0xff;

  decryptTGA(encrypted);
  for (let i = 2; i < 18; i++) assert.equal(encrypted[i], 100, `byte ${i}`);
});

// ----------------------------------------------------------------- PAT3D ---

test('PAT3D: parses a minimal model and resolves the TexLink pointer', () => {
  const pat = parsePAT3D(buildPAT3D());

  assert.equal(pat.header.objCounter, 1);
  assert.equal(pat.header.isVer066, false);
  assert.equal(pat.materialGroup.materialCount, 1);
  assert.equal(pat.materialGroup.materials[0].textures[0].name, 'test.bmp');

  const obj = pat.objects[0];
  assert.equal(obj.nodeName, 'obj0');
  assert.equal(obj.nVertex, 3);
  assert.equal(obj.nFace, 1);
  assert.equal(obj.parentIndex, -1);

  // 24.8 fixed point: 256 -> 1.0
  assert.deepEqual([obj.vertices[1].x, obj.vertices[1].y, obj.vertices[1].z], [1, 0, 0]);

  // pointer arithmetic resolved to index 0, and there is no second UV set
  assert.equal(obj.faces[0].texIndex, 0);
  assert.equal(obj.texLinks[0].nextIndex, -1);
  assert.deepEqual(obj.texLinks[0].u, [0, 1, 0]);
  assert.equal(obj.faces[0].matId, 0);
});

test('PAT3D: version 0.66 moves ObjInfo before each GeomObject', () => {
  const pat = parsePAT3D(buildPAT3D({ version: 'SMD Ver 0.66' }));
  assert.equal(pat.header.isVer066, true);
  assert.equal(pat.objects.length, 1);
  assert.equal(pat.objects[0].nVertex, 3, 'a 40-byte drift would corrupt this');
  assert.equal(pat.objects[0].nodeName, 'obj0');
});

test('PAT3D: the skin block is read only when lpPhysique is set', () => {
  const plain = parsePAT3D(buildPAT3D());
  assert.equal(plain.objects[0].boneNames, null);

  const skinned = parsePAT3D(
    buildPAT3D({ physique: 0x5000, boneNames: ['Bip01', 'Bip01 Spine', 'Bip01 Head'] }),
  );
  assert.deepEqual(skinned.objects[0].boneNames, ['Bip01', 'Bip01 Spine', 'Bip01 Head']);
});

test('PAT3D: a truncated file fails loudly rather than silently', () => {
  const full = new Uint8Array(buildPAT3D());
  assert.throws(
    () => parsePAT3D(full.slice(0, full.length - 40).buffer),
    /exceeds buffer|misaligned/,
  );
});

// --------------------------------------------------------------- STAGE3D ---

test('STAGE3D: parses a minimal map with the documented axis swap', () => {
  const stage = parseSTAGE3D(buildSTAGE3D());

  assert.equal(stage.vertices.length, 3);
  assert.equal(stage.faces.length, 1);
  assert.equal(stage.lights.length, 1);
  assert.equal(stage.materialGroup.materials[0].textures.length, 2, 'diffuse + lightmap');

  // file order (a, b, c) maps to (-c, b, -a)
  assert.deepEqual([stage.vertices[1].x, stage.vertices[1].y, stage.vertices[1].z], [-1, 0, -0]);
  assert.deepEqual([stage.vertices[2].x, stage.vertices[2].y, stage.vertices[2].z], [-0, 0, -1]);

  assert.equal(stage.faces[0].texIndex, 0);
  assert.deepEqual(stage.rect, { left: -1000, top: -1000, right: 1000, bottom: 1000 });
  assert.equal(stage.lights[0].r, 1);
});

test('STAGE3D: the Stage struct is exactly 262260 bytes', () => {
  // Proven implicitly by the parse above, but pinned here so a change to the
  // skip length fails a test instead of a map.
  assert.equal(SIZES.STAGE, 262260);
  assert.equal(SIZES.STAGE_AREA, 262144);
});

// ------------------------------------------------------------------- INX ---

test('INX: a classic file is exactly 67084 bytes and slices into clips', () => {
  const buffer = buildINX({ motions: [{ state: 0x040, startTick: 10, endTick: 70 }] });
  assert.equal(buffer.byteLength, INX_SIZE_CLASSIC);

  const inx = parseINX(buffer);
  assert.equal(inx.kpt, false);
  assert.equal(inx.modelFile, 'hero.smd');
  assert.equal(inx.motionFile, 'hero.smb');
  assert.equal(inx.motions.length, 1);

  const m = inx.motions[0];
  assert.equal(m.name, 'Idle');
  assert.equal(m.effectiveStartTick, 10);
  assert.equal(m.endTick, 70);
  assert.equal(m.reversed, false);
  assert.deepEqual(m.frameRange, [10 * FRAMES_PER_TICK, 70 * FRAMES_PER_TICK]);
});

test('INX: a backwards clip is detected and normalised', () => {
  const inx = parseINX(buildINX({ motions: [{ state: 0x120, startTick: 90, endTick: 30 }] }));
  const m = inx.motions[0];
  assert.equal(m.name, 'Die');
  assert.equal(m.reversed, true);
  assert.deepEqual(m.frameRange, [30 * FRAMES_PER_TICK, 90 * FRAMES_PER_TICK]);
});

test('INX: an unexpected file size is rejected', () => {
  assert.throws(() => parseINX(new ArrayBuffer(1024)), /unexpected \.inx size/);
});

// -------------------------------------------------------------- textures ---

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];

test('BMP: decodes 24-bit and keeps rows bottom-up', () => {
  // rowsBottomUp[0] is the bottom row of the image.
  const bmp = buildBMP(2, 2, [
    [RED, GREEN],
    [BLUE, WHITE],
  ]);
  const { width, height, data, hasAlpha } = decodeBMP(new Uint8Array(bmp));

  assert.equal(width, 2);
  assert.equal(height, 2);
  assert.equal(hasAlpha, false);
  assert.deepEqual([...data.slice(0, 4)], [255, 0, 0, 255], 'row 0 is the bottom row');
  assert.deepEqual([...data.slice(4, 8)], [0, 255, 0, 255]);
  assert.deepEqual([...data.slice(8, 12)], [0, 0, 255, 255]);
});

test('BMP: an odd width is padded to a 4-byte stride', () => {
  const bmp = buildBMP(3, 1, [[RED, GREEN, BLUE]]);
  const { data } = decodeBMP(new Uint8Array(bmp));
  assert.deepEqual([...data.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...data.slice(8, 12)], [0, 0, 255, 255]);
});

test('TGA: decodes 24-bit uncompressed bottom-up', () => {
  const tga = buildTGA(2, 2, [
    [RED, GREEN],
    [BLUE, WHITE],
  ]);
  const { width, height, data } = decodeTGA(new Uint8Array(tga));
  assert.equal(width, 2);
  assert.equal(height, 2);
  assert.deepEqual([...data.slice(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...data.slice(8, 12)], [0, 0, 255, 255]);
});

test('decodeImage: decrypts before decoding', () => {
  const bmp = new Uint8Array(buildBMP(2, 1, [[RED, GREEN]]));
  encryptBMP(bmp);
  assert.ok(isEncryptedBMP(bmp));

  const { width, data, format } = decodeImage(bmp, 'tex.bmp');
  assert.equal(format, 'bmp');
  assert.equal(width, 2);
  assert.deepEqual([...data.slice(0, 4)], [255, 0, 0, 255]);
});

// ----------------------------------------------------------------- paths ---

test('paths: helpers normalise Windows separators', () => {
  assert.equal(dirOf('char\\monster\\imp\\imp.smd'), 'char/monster/imp/');
  assert.equal(baseOf('char\\monster\\imp\\imp.smd'), 'imp.smd');
  assert.equal(stripExt('char/monster/imp/imp.ase.smd'), 'imp');
  assert.equal(changeExt('char/npc/a.ase', 'smd'), 'char/npc/a.smd');
  assert.equal(changeExt('noext', 'smd'), 'noext.smd');
});

test('paths: manifest lookup is case-insensitive and falls back to the basename', () => {
  const manifest = {
    'field/forest/rock02.bmp': 'field/forest/Rock02.BMP',
    'shared.tga': 'common/Shared.TGA',
  };

  assert.equal(
    resolveAssetPath('field/forest/', 'ROCK02.BMP', manifest),
    'field/forest/Rock02.BMP',
  );
  assert.equal(resolveAssetPath('field/forest/', 'shared.tga', manifest), 'common/Shared.TGA');
  assert.equal(resolveAssetPath('field/forest/', 'missing.bmp', manifest), null);
  assert.equal(resolveAssetPath('a/', 'b.bmp', null), 'a/b.bmp');
});
