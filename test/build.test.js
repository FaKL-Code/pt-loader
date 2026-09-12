import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { parsePAT3D } from '../src/formats/pat3d.js';
import { parseSTAGE3D } from '../src/formats/stage3d.js';
import { parseINX } from '../src/formats/inx.js';
import { mat4FromFile, invertSafe, bindMatrixOf } from '../src/build/math.js';
import {
  buildGeometry,
  computeSmoothNormals,
  buildCollisionGeometry,
} from '../src/build/geometry.js';
import {
  createMaterial,
  scrollSpeedOf,
  shouldSkipMaterial,
  windEffectOf,
} from '../src/build/materials.js';
import { buildModel, buildStage, buildCollisionMesh } from '../src/build/model.js';
import { extractBoneTracks, buildClips } from '../src/build/animation.js';
import { BLEND, SCRIPT, FRAMES_PER_SECOND } from '../src/formats/constants.js';

import { buildPAT3D, buildSTAGE3D, buildSMB, buildINX } from './helpers/write.js';

const NO_TEX = () => ({ diffuse: null, lightmap: null, anim: [], diffuseHasAlpha: false });

// ------------------------------------------------------------------ math ---

test('mat4FromFile transposes and normalises the fixed-point scale', () => {
  // File order is _11 _12 _13 _14 _21 ... with a translation in the last row,
  // which is Direct3D's row-vector convention.
  const f = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 7, 9, 1];
  const m = mat4FromFile(f);

  assert.equal(m.elements[15], 1, 'the homogeneous term must end up as 1');

  // After transposing, the translation lives in the last column, so a point
  // transformed by it is simply offset.
  const p = new THREE.Vector3(1, 2, 3).applyMatrix4(m);
  assert.deepEqual([p.x, p.y, p.z], [6, 9, 12]);
});

test('invertSafe falls back to identity for a degenerate matrix', () => {
  const zero = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  const inv = invertSafe(zero);
  assert.ok(inv.equals(new THREE.Matrix4()), 'must not collapse vertices onto the origin');
});

test('bindMatrixOf inverts the stored inverse-bind matrix', () => {
  // transformInvert holds a translation of -4 along x; inverting yields +4.
  const obj = { transformInvert: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -4, 0, 0, 1] };
  const p = new THREE.Vector3(0, 0, 0).applyMatrix4(bindMatrixOf(obj));
  assert.ok(Math.abs(p.x - 4) < 1e-6, `expected x=4, got ${p.x}`);
});

// -------------------------------------------------------------- geometry ---

test('buildGeometry emits non-indexed triangles with V flipped', () => {
  const pat = parsePAT3D(buildPAT3D());
  const obj = pat.objects[0];

  const positions = new Float32Array(obj.nVertex * 3);
  obj.vertices.forEach((v, i) => {
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  });

  const g = buildGeometry({
    faces: obj.faces,
    texLinks: obj.texLinks,
    positions,
    matId: 0,
  });

  assert.ok(g, 'the single face uses material 0');
  assert.equal(g.getAttribute('position').count, 3);
  assert.equal(g.index, null, 'geometry must stay non-indexed');

  // The fixture stores u = [0,1,0] and v = [0,0,1]; V is flipped to 1 - v.
  const uv = g.getAttribute('uv');
  assert.deepEqual([uv.getX(0), uv.getY(0)], [0, 1]);
  assert.deepEqual([uv.getX(1), uv.getY(1)], [1, 1]);
  assert.deepEqual([uv.getX(2), uv.getY(2)], [0, 0]);

  assert.equal(g.getAttribute('uv1'), undefined, 'no lightmap channel in this fixture');
});

test('buildGeometry returns null when no face uses the material', () => {
  const pat = parsePAT3D(buildPAT3D());
  const obj = pat.objects[0];
  const positions = new Float32Array(obj.nVertex * 3);
  assert.equal(
    buildGeometry({ faces: obj.faces, texLinks: obj.texLinks, positions, matId: 3 }),
    null,
  );
});

test('computeSmoothNormals averages face normals per source vertex', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const faces = [{ v: [0, 1, 2] }];
  const n = computeSmoothNormals(faces, positions, 3);
  // The triangle lies in the XZ plane, so every normal points along Y.
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(Math.abs(n[i * 3 + 1]) - 1) < 1e-6, `vertex ${i} normal should be +/-Y`);
  }
});

test('buildCollisionGeometry welds and indexes only collidable faces', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5]);
  const faces = [
    { v: [0, 1, 2], matId: 0 },
    { v: [1, 2, 3], matId: 1 },
  ];
  const g = buildCollisionGeometry(faces, positions, (id) => id === 0);

  assert.equal(g.getAttribute('position').count, 3, 'vertex 3 is unused and dropped');
  assert.equal(g.index.count, 3);
});

// -------------------------------------------------------------- materials ---

test('createMaterial maps BlendType onto three.js blending', () => {
  const base = {
    inUse: 1,
    textureCounter: 1,
    textureFormState: [0, 0, 0, 0, 0, 0, 0, 0],
    mapOpacity: 0,
    textureType: 0,
    twoSide: 0,
    diffuse: { r: 1, g: 1, b: 1 },
    transparency: 0,
    selfIllum: 0,
    useState: 0,
    meshState: 1,
    windMeshBottom: 0,
    animTexCounter: 0,
    shiftFrameSpeed: 6,
    serialNum: 1,
    textures: [],
    animTextures: [],
  };

  const none = createMaterial({ ...base, blendType: BLEND.NONE }, NO_TEX()).material;
  assert.equal(none.transparent, false);

  const alpha = createMaterial({ ...base, blendType: BLEND.ALPHA }, NO_TEX()).material;
  assert.equal(alpha.transparent, true);
  assert.equal(alpha.blending, THREE.NormalBlending);

  const additive = createMaterial({ ...base, blendType: BLEND.LAMP }, NO_TEX()).material;
  assert.equal(additive.blending, THREE.AdditiveBlending);
  assert.equal(additive.depthWrite, false, 'additive surfaces must not write depth');

  const multiply = createMaterial({ ...base, blendType: BLEND.COLOR }, NO_TEX()).material;
  assert.equal(multiply.blending, THREE.MultiplyBlending);
});

test('createMaterial: cutout wins over transparency and stays in the opaque queue', () => {
  const m = {
    inUse: 1,
    textureCounter: 1,
    textureFormState: [0, 0, 0, 0, 0, 0, 0, 0],
    mapOpacity: 1,
    textureType: 0,
    blendType: BLEND.ALPHA,
    twoSide: 0,
    diffuse: { r: 1, g: 1, b: 1 },
    transparency: 0.5,
    selfIllum: 0,
    useState: 0,
    meshState: 1,
    windMeshBottom: 0,
    animTexCounter: 0,
    shiftFrameSpeed: 6,
    serialNum: 1,
    textures: [],
    animTextures: [],
  };
  const { material } = createMaterial(m, NO_TEX());

  assert.equal(material.alphaTest, 0.5);
  assert.equal(material.transparent, false, 'cutout stays opaque: no back-to-front sorting');
  assert.equal(material.depthWrite, true);
  assert.equal(material.side, THREE.DoubleSide);
});

test('createMaterial: semi-transparent materials disable depth write', () => {
  const m = {
    inUse: 1,
    textureCounter: 1,
    textureFormState: [0, 0, 0, 0, 0, 0, 0, 0],
    mapOpacity: 0,
    textureType: 0,
    blendType: BLEND.NONE,
    twoSide: 0,
    diffuse: { r: 1, g: 1, b: 1 },
    transparency: 0.25,
    selfIllum: 0,
    useState: 0,
    meshState: 1,
    windMeshBottom: 0,
    animTexCounter: 0,
    shiftFrameSpeed: 6,
    serialNum: 1,
    textures: [],
    animTextures: [],
  };
  const { material } = createMaterial(m, NO_TEX());
  assert.equal(material.transparent, true);
  assert.ok(Math.abs(material.opacity - 0.75) < 1e-6);
  assert.equal(material.depthWrite, false);
});

test('scrollSpeedOf decodes the TextureFormState table', () => {
  const f = (n) => scrollSpeedOf({ textureFormState: [n] });
  // 6..14: speed = 15 - n
  assert.equal(f(6), 9);
  assert.equal(f(14), 1);
  // 15..18: speed = (128 >> (18 - n + 4)) / 256
  assert.equal(f(15), 1 / 256);
  assert.equal(f(18), 8 / 256);
  // anything else falls back to 1
  assert.equal(f(0), 1);
});

test('shouldSkipMaterial rejects unused, textureless and invisible materials', () => {
  const ok = { inUse: 1, textureCounter: 1, animTexCounter: 0, useState: 0 };
  assert.equal(shouldSkipMaterial(ok), false);
  assert.equal(shouldSkipMaterial({ ...ok, inUse: 0 }), true);
  assert.equal(shouldSkipMaterial({ ...ok, textureCounter: 0 }), true);
  assert.equal(shouldSkipMaterial({ ...ok, useState: SCRIPT.NOTVIEW }), true);
});

test('windEffectOf ignores blinking materials', () => {
  assert.equal(windEffectOf({ windMeshBottom: SCRIPT.WINDX1, useState: 0 }), SCRIPT.WINDX1);
  assert.equal(windEffectOf({ windMeshBottom: SCRIPT.WINDX1, useState: SCRIPT.BLINK_COLOR }), 0);
  assert.equal(windEffectOf({ windMeshBottom: 0, useState: 0 }), 0);
});

// ----------------------------------------------------------------- model ---

test('buildModel produces a renderable group from a parsed model', () => {
  const pat = parsePAT3D(buildPAT3D());
  const root = buildModel(pat, { resolveTextures: NO_TEX, name: 'item' });

  const meshes = [];
  root.traverse((o) => o.isMesh && meshes.push(o));

  assert.equal(meshes.length, 1);
  assert.equal(meshes[0].geometry.getAttribute('position').count, 3);
  assert.ok(Math.abs(root.rotation.x + Math.PI / 2) < 1e-6, 'Z-up to Y-up fix applied');
  assert.equal(typeof root.userData.ptUpdate, 'function');
  assert.equal(meshes[0].userData.pt.materialIndex, 0);
  assert.deepEqual(meshes[0].userData.pt.textureNames, ['test.bmp']);
});

test('buildStage produces one mesh per material and keeps the map metadata', () => {
  const stage = parseSTAGE3D(buildSTAGE3D());
  const root = buildStage(stage, { resolveTextures: NO_TEX, name: 'map' });

  const meshes = [];
  root.traverse((o) => o.isMesh && meshes.push(o));
  assert.equal(meshes.length, 1);
  assert.equal(root.userData.ptLights.length, 1);
  assert.deepEqual(root.userData.ptRect, { left: -1000, top: -1000, right: 1000, bottom: 1000 });
});

test('buildCollisionMesh keeps only collidable faces and is invisible', () => {
  const stage = parseSTAGE3D(buildSTAGE3D());
  const mesh = buildCollisionMesh(stage);
  assert.ok(mesh, 'the fixture material has MeshState bit 0 set');
  assert.equal(mesh.material.visible, false);
  assert.equal(mesh.geometry.index.count, 3);
});

test('buildModel binds a SkinnedMesh when the object carries skin weights', () => {
  const skeletonPat = parsePAT3D(buildSMB([{ name: 'Bip01' }]));
  const pat = parsePAT3D(buildPAT3D({ physique: 0x5000, boneNames: ['Bip01', 'Bip01', 'Bip01'] }));

  const root = buildModel(pat, { resolveTextures: NO_TEX, skeletonPat, name: 'char' });

  const skinned = [];
  root.traverse((o) => o.isSkinnedMesh && skinned.push(o));

  assert.equal(skinned.length, 1);
  assert.ok(skinned[0].skeleton, 'skeleton must be bound');
  assert.equal(skinned[0].geometry.getAttribute('skinIndex').count, 3);
  assert.equal(skinned[0].geometry.getAttribute('skinWeight').getX(0), 1, 'rigid binding');
  assert.ok(root.userData.ptSkeleton);
});

// ------------------------------------------------------------- animation ---

test('extractBoneTracks accumulates rotation deltas', () => {
  // Two identical 90-degree-about-Y deltas after an identity first key.
  const s = Math.SQRT1_2;
  const smb = buildSMB([
    {
      name: 'Bip01',
      q: [0, 0, 0, 1],
      rot: [
        { frame: 0, x: 0, y: 0, z: 0, w: 1 },
        { frame: 160, x: 0, y: s, z: 0, w: s },
        { frame: 320, x: 0, y: s, z: 0, w: s },
      ],
    },
  ]);

  const pat = parsePAT3D(smb);
  const tracks = extractBoneTracks(pat.objects[0]);

  assert.deepEqual(tracks.rot.times, [0, 160, 320]);

  const euler = tracks.rot.values.map((q) => new THREE.Euler().setFromQuaternion(q, 'YXZ').y);
  assert.ok(Math.abs(euler[0]) < 1e-5, `key 0 should be identity, got ${euler[0]}`);
  assert.ok(Math.abs(euler[1] + Math.PI / 2) < 1e-5, `key 1 should be -90deg, got ${euler[1]}`);
  // Without accumulation this would also read -90 degrees; accumulation makes it -180.
  assert.ok(
    Math.abs(Math.abs(euler[2]) - Math.PI) < 1e-5,
    `key 2 should be -180deg, got ${euler[2]}`,
  );
});

test('extractBoneTracks emits absolute positions, not bind-relative deltas', () => {
  const smb = buildSMB([
    {
      name: 'Bip01',
      p: [10, 0, 0],
      pos: [
        { frame: 0, x: 10, y: 0, z: 0 },
        { frame: 160, x: 12, y: 0, z: 0 },
      ],
    },
  ]);
  const pat = parsePAT3D(smb);
  const tracks = extractBoneTracks(pat.objects[0]);

  // jMonkeyEngine stores (value - bind); three.js wants the raw value.
  assert.deepEqual(tracks.pos.values, [
    [10, 0, 0],
    [12, 0, 0],
  ]);
});

test('buildClips slices an .inx motion into its own clip with rebased times', () => {
  const s = Math.SQRT1_2;
  const smb = buildSMB([
    {
      name: 'Bip01',
      rot: [
        { frame: 0, x: 0, y: 0, z: 0, w: 1 },
        { frame: 10 * 160, x: 0, y: s, z: 0, w: s },
        { frame: 70 * 160, x: 0, y: s, z: 0, w: s },
        { frame: 90 * 160, x: 0, y: s, z: 0, w: s },
      ],
    },
  ]);
  const pat = parsePAT3D(smb);
  const inx = parseINX(buildINX({ motions: [{ state: 0x040, startTick: 10, endTick: 70 }] }));

  const { clips, byState } = buildClips(pat, inx);

  assert.ok(clips.Idle, 'clip named after MotionInfo.State');
  assert.equal(byState[0x040], 'Idle');

  const track = clips.Idle.tracks.find((t) => t.name === 'Bip01.quaternion');
  assert.ok(track);
  assert.equal(track.times.length, 2, 'only the two keys inside [10, 70] ticks');
  assert.ok(Math.abs(track.times[0]) < 1e-9, 'times rebased to start at zero');

  const expected = ((70 - 10) * 160) / FRAMES_PER_SECOND;
  assert.ok(Math.abs(clips.Idle.duration - expected) < 1e-6, `duration ${clips.Idle.duration}`);
  assert.ok(clips.Full, 'the unsliced animation is always available');
});

test('buildClips holds the last value when a channel has no key in the window', () => {
  const smb = buildSMB([
    {
      name: 'Bip01',
      rot: [{ frame: 0, x: 0, y: 0, z: 0, w: 1 }],
    },
  ]);
  const pat = parsePAT3D(smb);
  const inx = parseINX(buildINX({ motions: [{ state: 0x050, startTick: 40, endTick: 60 }] }));

  const { clips } = buildClips(pat, inx);
  const track = clips.Walk.tracks.find((t) => t.name === 'Bip01.quaternion');

  assert.ok(track, 'the bone must not vanish from the clip');
  assert.equal(track.times.length, 1, 'a single held key keeps the bone in place');
});
