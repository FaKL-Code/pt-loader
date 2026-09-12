import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { PTLoader } from '../src/index.js';
import { encryptBMP } from '../src/io/crypto.js';
import { buildPAT3D, buildSMB, buildINX, buildBMP } from './helpers/write.js';

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];

/** An in-memory asset server, so the whole stack runs end to end in Node. */
function makeFakeServer() {
  const encryptedBmp = new Uint8Array(
    buildBMP(2, 2, [
      [RED, GREEN],
      [GREEN, RED],
    ]),
  );
  encryptBMP(encryptedBmp);

  const files = new Map([
    ['items/it0123.smd', buildPAT3D()],
    ['items/test.bmp', encryptedBmp.buffer.slice(0)],

    ['char/hero.inx', buildINX({ motions: [{ state: 0x040, startTick: 0, endTick: 2 }] })],
    ['char/hero.smd', buildPAT3D({ physique: 0x5000, boneNames: ['Bip01', 'Bip01', 'Bip01'] })],
    [
      'char/hero.smb',
      buildSMB([
        {
          name: 'Bip01',
          rot: [
            { frame: 0, x: 0, y: 0, z: 0, w: 1 },
            { frame: 160, x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
            { frame: 320, x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
          ],
        },
      ]),
    ],
    ['char/test.bmp', encryptedBmp.buffer.slice(0)],
  ]);

  const manifest = {};
  for (const key of files.keys()) manifest[key.toLowerCase()] = key;
  manifest['test.bmp'] = 'items/test.bmp';

  const requested = [];
  const fetchImpl = async (url) => {
    const path = url.replace(/^\/pt-assets\//, '');
    requested.push(path);
    const body = files.get(path);
    if (!body) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => body };
  };

  return { fetchImpl, manifest, requested };
}

test('end to end: loadModel produces a textured mesh', async () => {
  const { fetchImpl, manifest } = makeFakeServer();
  const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest, fetch: fetchImpl });

  const group = await loader.loadModel('items/it0123.smd');

  const meshes = [];
  group.traverse((o) => o.isMesh && meshes.push(o));
  assert.equal(meshes.length, 1);

  const mesh = meshes[0];
  assert.equal(mesh.geometry.getAttribute('position').count, 3);
  assert.ok(mesh.material.map, 'the diffuse texture must be attached');
  assert.equal(mesh.material.map.name, 'test.bmp');
  assert.equal(mesh.material.map.image.width, 2);
  assert.equal(mesh.material.map.flipY, false, 'decoded data is already bottom-up');
  assert.equal(mesh.material.map.colorSpace, THREE.SRGBColorSpace);
  assert.deepEqual(mesh.userData.pt.textureNames, ['test.bmp']);

  loader.dispose();
});

test('end to end: an unresolved texture falls back to the checker, not an error', async () => {
  const { fetchImpl } = makeFakeServer();
  // An empty manifest resolves nothing.
  const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest: {}, fetch: fetchImpl });
  // The .smd itself still resolves because #resolve passes paths through.
  const group = await loader.loadModel('items/it0123.smd');

  const meshes = [];
  group.traverse((o) => o.isMesh && meshes.push(o));
  assert.equal(meshes.length, 1, 'the model must still render');
  assert.equal(meshes[0].material.map.name, 'pt_missing', 'the checker keeps its own name');
  assert.equal(meshes[0].material.map.image.width, 2, 'the 2x2 checker stands in');
  assert.ok(loader.textures.missingPaths.size > 0, 'the unresolved name is recorded once');

  loader.dispose();
});

test('end to end: loadCharacter wires skeleton, clips and mixer', async () => {
  const { fetchImpl, manifest } = makeFakeServer();
  const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest, fetch: fetchImpl });

  const character = await loader.loadCharacter('char/hero.inx');

  assert.ok(character.inx, 'the .inx must be parsed');
  assert.equal(character.inx.modelFile, 'hero.smd');
  assert.ok(character.skeleton, 'a skeleton must be bound');

  const skinned = [];
  character.object.traverse((o) => o.isSkinnedMesh && skinned.push(o));
  assert.equal(skinned.length, 1);
  assert.equal(skinned[0].geometry.getAttribute('skinWeight').getX(0), 1);

  assert.ok(character.clipNames.includes('Idle'), `clips: ${character.clipNames}`);
  assert.ok(character.clipNames.includes('Full'));

  // The mixer must resolve the track targets by bone name.
  const mixer = character.createMixer();
  const action = character.play('Idle', mixer);
  assert.ok(action, 'play() must return an action');
  mixer.update(0.016);
  assert.ok(action.isRunning());

  loader.dispose();
});

test('end to end: moving the group after load does not double-transform the skin', async () => {
  const { fetchImpl, manifest } = makeFakeServer();
  const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest, fetch: fetchImpl });
  const { object } = await loader.loadCharacter('char/hero.inx');

  const before = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
  object.position.set(100, 0, 0);
  object.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());

  assert.ok(
    Math.abs(after.x - before.x - 100) < 1e-3,
    `expected a 100-unit shift, got ${after.x - before.x}`,
  );

  loader.dispose();
});

test('end to end: update() drives animated materials and release() frees them', async () => {
  const { fetchImpl, manifest } = makeFakeServer();
  const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest, fetch: fetchImpl });
  const group = await loader.loadModel('items/it0123.smd');

  assert.equal(typeof group.userData.ptUpdate, 'function');
  loader.update(1.25); // must not throw even with no animators
  assert.ok(loader.updatables.has(group));

  loader.release(group);
  assert.equal(loader.updatables.has(group), false);

  loader.dispose();
});

test('end to end: concurrent requests for the same file are deduplicated', async () => {
  const { fetchImpl, manifest, requested } = makeFakeServer();
  const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest, fetch: fetchImpl });

  await Promise.all([
    loader.loadModel('items/it0123.smd'),
    loader.loadModel('items/it0123.smd'),
    loader.loadModel('items/it0123.smd'),
  ]);

  assert.equal(requested.filter((p) => p === 'items/it0123.smd').length, 1);
  assert.equal(requested.filter((p) => p === 'items/test.bmp').length, 1);

  loader.dispose();
});

test('requestInit applies authorization to models and textures', async () => {
  const server = makeFakeServer();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return server.fetchImpl(url);
  };
  const loader = new PTLoader({
    baseUrl: '/pt-assets/',
    manifest: server.manifest,
    fetch: fetchImpl,
    requestInit: async ({ path, kind }) => ({
      credentials: 'include',
      cache: 'no-store',
      headers: { Authorization: `Asset ${kind}:${path}` },
    }),
  });

  await loader.loadModel('items/it0123.smd');

  const model = calls.find(({ url }) => url.endsWith('it0123.smd'));
  const texture = calls.find(({ url }) => url.endsWith('test.bmp'));
  assert.ok(model, 'model request was captured');
  assert.ok(texture, 'texture request was captured');
  assert.equal(model.init.credentials, 'include');
  assert.equal(model.init.cache, 'no-store');
  assert.equal(model.init.headers.Authorization, 'Asset model:items/it0123.smd');
  assert.equal(texture.init.headers.Authorization, 'Asset texture:items/test.bmp');

  loader.dispose();
});

test('an authorization failure is evicted so loading can retry after login', async () => {
  const server = makeFakeServer();
  let authorized = false;
  const fetchImpl = async (url) => {
    if (!authorized) {
      return { ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return server.fetchImpl(url);
  };
  const loader = new PTLoader({
    baseUrl: '/pt-assets/',
    manifest: server.manifest,
    fetch: fetchImpl,
  });

  await assert.rejects(loader.loadModel('items/it0123.smd'), /HTTP 401/);
  authorized = true;
  const model = await loader.loadModel('items/it0123.smd');
  assert.equal(model.isGroup, true);

  loader.dispose();
});

test('asset response limits reject oversized files before parsing', async () => {
  const loader = new PTLoader({
    baseUrl: '/pt-assets/',
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '100' }),
      arrayBuffer: async () => new ArrayBuffer(100),
    }),
    maxAssetBytes: 10,
  });

  await assert.rejects(loader.fetchBuffer('items/large.smd', 'model'), /byte limit/);
  loader.dispose();
});

test('manifests reject unsafe target paths', () => {
  assert.throws(
    () => new PTLoader({ manifest: { 'item.smd': '../private/item.smd' } }),
    /unsafe asset path/,
  );
});
