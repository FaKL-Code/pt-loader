import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { parsePAT3D } from '../src/formats/pat3d.js';
import { buildModel } from '../src/build/model.js';
import {
  pickAt,
  findMeshesByTexture,
  sampleTextureAlpha,
  PTHighlight,
} from '../src/build/picking.js';
import { buildPAT3D, buildSMB } from './helpers/write.js';

const NO_TEX = () => ({ diffuse: null, lightmap: null, anim: [], diffuseHasAlpha: false });

/**
 * The fixture triangle is (0,0,0) (1,0,0) (0,1,0). Disabling `upAxisFix` keeps
 * it in the XY plane so a camera on +Z looking at -Z hits it head on.
 */
function makeScene({ copies = 1 } = {}) {
  const root = new THREE.Group();
  for (let i = 0; i < copies; i++) {
    const pat = parsePAT3D(buildPAT3D());
    const model = buildModel(pat, {
      resolveTextures: NO_TEX,
      name: `model${i}`,
      options: { upAxisFix: false },
    });
    model.position.x = i * 10;
    root.add(model);
  }

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0.2, 0.2, 5);
  camera.lookAt(0.2, 0.2, 0);
  camera.updateMatrixWorld(true);
  root.updateMatrixWorld(true);

  return { root, camera, pointer: new THREE.Vector2(0, 0) };
}

function firstMesh(root) {
  let found = null;
  root.traverse((o) => {
    if (!found && o.isMesh && !o.userData.ptHighlight) found = o;
  });
  return found;
}

// ----------------------------------------------------------------- pickAt ---

test('pickAt returns the surface under the pointer with its material metadata', () => {
  const { root, camera, pointer } = makeScene();
  const hit = pickAt({ root, camera, pointer });

  assert.ok(hit, 'the ray must hit the triangle');
  assert.equal(hit.mesh, firstMesh(root));
  assert.equal(hit.textureName, 'test.bmp');
  assert.deepEqual(hit.textureNames, ['test.bmp']);
  assert.equal(hit.materialIndex, 0);
  assert.equal(hit.nodeName, 'obj0');
  assert.equal(hit.blendType, 0);
  assert.ok(hit.point instanceof THREE.Vector3);
  assert.ok(hit.uv, 'UVs are needed for the alpha test');
  assert.ok(Math.abs(hit.point.z) < 1e-6, `hit should land on the z=0 plane, got ${hit.point.z}`);
});

test('pickAt returns null when the ray misses everything', () => {
  const { root, camera } = makeScene();
  const hit = pickAt({ root, camera, pointer: new THREE.Vector2(0.95, 0.95) });
  assert.equal(hit, null);
});

test('pickAt collects sibling surfaces sharing the same texture', () => {
  const { root, camera, pointer } = makeScene({ copies: 3 });
  const hit = pickAt({ root, camera, pointer });

  assert.ok(hit);
  assert.equal(hit.siblings.length, 2, 'the other two copies use the same texture');
  assert.ok(!hit.siblings.includes(hit.mesh), 'the picked surface is not its own sibling');
});

test('pickAt can skip sibling collection', () => {
  const { root, camera, pointer } = makeScene({ copies: 3 });
  const hit = pickAt({ root, camera, pointer, siblings: false });
  assert.deepEqual(hit.siblings, []);
});

test('pickAt ignores the invisible collision mesh', () => {
  const { root, camera, pointer } = makeScene();

  // A collision mesh sits in front of the model and must never be selected.
  const blocker = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  blocker.position.set(0.2, 0.2, 2);
  blocker.name = 'pt_collision';
  root.add(blocker);
  root.updateMatrixWorld(true);

  const hit = pickAt({ root, camera, pointer });
  assert.ok(hit);
  assert.notEqual(hit.mesh, blocker);
  assert.equal(hit.textureName, 'test.bmp');
});

test('pickAt ignores highlight overlays, so re-picking selects the real surface', () => {
  const { root, camera, pointer } = makeScene();
  const highlight = new PTHighlight();

  const first = pickAt({ root, camera, pointer });
  highlight.show(first);
  root.updateMatrixWorld(true);

  const second = pickAt({ root, camera, pointer });
  assert.ok(second);
  assert.equal(second.mesh, first.mesh, 'the overlay must not shadow its own surface');
  assert.equal(second.mesh.userData.ptHighlight, undefined);

  highlight.dispose();
});

test('pickAt skips transparent texels of cutout materials', () => {
  const { root, camera, pointer } = makeScene();
  const mesh = firstMesh(root);

  // A fully transparent 2x2 cutout texture: every texel is a hole.
  const data = new Uint8Array(2 * 2 * 4); // alpha stays 0
  mesh.material.map = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
  mesh.material.alphaTest = 0.5;

  assert.equal(pickAt({ root, camera, pointer }), null, 'a hole is not a surface');
  assert.ok(pickAt({ root, camera, pointer, alphaTest: false }), 'opt-out still hits');
});

// ------------------------------------------------------ sampleTextureAlpha ---

test('sampleTextureAlpha reads the bottom-up buffer at the right texel', () => {
  // 2x2 RGBA, row 0 is the bottom of the image.
  const data = new Uint8Array([
    0,
    0,
    0,
    10,
    0,
    0,
    0,
    20, // bottom row: alpha 10, 20
    0,
    0,
    0,
    30,
    0,
    0,
    0,
    40, // top row:    alpha 30, 40
  ]);
  const tex = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);

  assert.equal(sampleTextureAlpha(tex, 0.25, 0.25), 10);
  assert.equal(sampleTextureAlpha(tex, 0.75, 0.25), 20);
  assert.equal(sampleTextureAlpha(tex, 0.25, 0.75), 30);
  assert.equal(sampleTextureAlpha(tex, 0.75, 0.75), 40);
});

test('sampleTextureAlpha wraps out-of-range UVs and tolerates GPU-only textures', () => {
  const data = new Uint8Array([0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0, 40]);
  const tex = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);

  assert.equal(sampleTextureAlpha(tex, 1.25, 0.25), 10, 'u wraps like RepeatWrapping');
  assert.equal(sampleTextureAlpha(tex, -0.75, 0.25), 10);

  // Browser-decoded images keep no CPU pixels; treat them as opaque.
  assert.equal(sampleTextureAlpha(new THREE.Texture(), 0.5, 0.5), 255);
  assert.equal(sampleTextureAlpha(null, 0.5, 0.5), 255);
});

// -------------------------------------------------- findMeshesByTexture ---

test('findMeshesByTexture matches case-insensitively and skips overlays', () => {
  const { root } = makeScene({ copies: 3 });

  assert.equal(findMeshesByTexture(root, 'test.bmp').length, 3);
  assert.equal(findMeshesByTexture(root, 'TEST.BMP').length, 3);
  assert.equal(findMeshesByTexture(root, 'nope.bmp').length, 0);
  assert.equal(findMeshesByTexture(root, null).length, 0);

  const highlight = new PTHighlight();
  highlight.show(firstMesh(root), []);
  assert.equal(findMeshesByTexture(root, 'test.bmp').length, 3, 'overlays are not surfaces');
  highlight.dispose();
});

// ------------------------------------------------------------- PTHighlight ---

test('PTHighlight adds one overlay per surface and removes them all on clear', () => {
  const { root, camera, pointer } = makeScene({ copies: 3 });
  const highlight = new PTHighlight();
  const hit = pickAt({ root, camera, pointer });

  highlight.show(hit);
  assert.equal(highlight.active, true);
  assert.equal(highlight.overlays.size, 3, 'picked surface plus two siblings');

  const overlays = [];
  root.traverse((o) => o.userData.ptHighlight && overlays.push(o));
  assert.equal(overlays.length, 3);
  assert.ok(overlays.every((o) => o.material.wireframe));
  assert.equal(
    overlays.filter((o) => o.material === highlight.primaryMaterial).length,
    1,
    'exactly one surface uses the primary colour',
  );

  highlight.clear();
  assert.equal(highlight.active, false);
  let remaining = 0;
  root.traverse((o) => o.userData.ptHighlight && remaining++);
  assert.equal(remaining, 0);

  highlight.dispose();
});

test('PTHighlight.show replaces the previous selection instead of stacking', () => {
  const { root, camera, pointer } = makeScene({ copies: 3 });
  const highlight = new PTHighlight();
  const hit = pickAt({ root, camera, pointer });

  highlight.show(hit);
  highlight.show(hit);
  highlight.show(hit);

  let overlays = 0;
  root.traverse((o) => o.userData.ptHighlight && overlays++);
  assert.equal(overlays, 3, 'three shows must not produce nine overlays');

  highlight.dispose();
});

test('PTHighlight accepts a bare mesh and shares the source geometry', () => {
  const { root } = makeScene();
  const mesh = firstMesh(root);
  const highlight = new PTHighlight();

  highlight.show(mesh);
  const overlay = highlight.overlays.get(mesh);

  assert.ok(overlay);
  assert.equal(overlay.parent, mesh, 'overlay inherits the exact transform');
  assert.equal(overlay.geometry, mesh.geometry, 'geometry is shared, never cloned');
  assert.equal(typeof overlay.raycast, 'function');
  assert.equal(overlay.raycast(), undefined, 'overlays are not pickable');

  highlight.clear();
  // Clearing must not dispose the shared geometry.
  assert.ok(mesh.geometry.getAttribute('position'));
  highlight.dispose();
});

test('PTHighlight outlines a skinned surface with a bound SkinnedMesh', () => {
  const skeletonPat = parsePAT3D(buildSMB([{ name: 'Bip01' }]));
  const pat = parsePAT3D(buildPAT3D({ physique: 0x5000, boneNames: ['Bip01', 'Bip01', 'Bip01'] }));
  const root = buildModel(pat, { resolveTextures: NO_TEX, skeletonPat, name: 'char' });

  let skinned = null;
  root.traverse((o) => {
    if (!skinned && o.isSkinnedMesh) skinned = o;
  });
  assert.ok(skinned);

  const highlight = new PTHighlight();
  highlight.show(skinned);
  const overlay = highlight.overlays.get(skinned);

  assert.ok(overlay.isSkinnedMesh, 'a plain Mesh overlay would not follow the animation');
  assert.equal(overlay.skeleton, skinned.skeleton, 'same skeleton, so the outline deforms too');
  assert.equal(overlay.frustumCulled, false);

  highlight.dispose();
});
