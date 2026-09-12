# @fakl-code/pt-loader

[![CI](https://github.com/FaKL-Code/pt-loader/actions/workflows/ci.yml/badge.svg)](https://github.com/FaKL-Code/pt-loader/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/node-%3E%3D18-5fa04e)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2bd3ff)](./LICENSE)

Load Priston Tale 3D assets — `.smd` models and maps, `.smb` skeletons, `.inx`
animation indices, and the game's obfuscated BMP/TGA textures — directly in the
browser with [three.js](https://threejs.org).

Published as minified ESM without source maps. `three` is a peer dependency and
no game assets are included.

```js
import { PTLoader } from '@fakl-code/pt-loader';

const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest });
scene.add(await loader.loadModel('image/Sinimage/Items/DropItem/it0123.smd'));
```

---

## Contents

- [Install](#install)
- [Step 1 — prepare the assets](#step-1--prepare-the-assets) ← **do not skip**
- [Step 2 — use the loader](#step-2--use-the-loader)
- [Protecting models and textures](#protecting-models-and-textures)
- [Private server-rendered previews](#private-server-rendered-previews)
- [Picking surfaces](#f-picking-a-surface-the-texture-picker)
- [API](#api)
- [Build options](#build-options)
- [Contracts you must not break](#contracts-you-must-not-break)
- [Troubleshooting](#troubleshooting)
- [Node / offline pipeline](#node--offline-pipeline)
- [Limitations](#limitations)

---

## Install

Install the tagged GitHub release:

```bash
npm install github:FaKL-Code/pt-loader#v0.1.0 three
```

The package name is `@fakl-code/pt-loader`; a registry release can be installed
with `npm install @fakl-code/pt-loader three` once it is published to npm.

Requirements:

|         |                                                                                  |
| ------- | -------------------------------------------------------------------------------- |
| `three` | `>= 0.152` — the second UV set is read from the `uv1` attribute, renamed in r152 |
| Node    | `>= 18` for the `pt-assets` CLI                                                  |
| Browser | any WebGL2 browser; `PTViewer` uses Pointer Events                               |

The package ships plain ESM from `src/`. Vite, webpack 5, Rollup, Parcel and
Next.js consume it without configuration. There is nothing to transpile and no
`postinstall`.

### If you link the package locally

A normal install (registry, tarball, or git) deduplicates `three` correctly —
`npm ls three` shows `deduped`. But `npm install file:../pt-loader` creates a
symlink, and Node resolves `three` from the package's _real_ location, so a
`three` anywhere above that path shadows yours. Two copies of three.js break
every `instanceof` check.

Verify with `npm ls three`, then tell your bundler to force a single copy:

```js
// vite.config.js
export default { resolve: { dedupe: ['three'] } };
```

```js
// webpack.config.js
module.exports = { resolve: { alias: { three: path.resolve('./node_modules/three') } } };
```

When developing the loader itself, `npm install` installs the single compatible
copy of `three` used by the test suite.

### Entry points

| Import                        | Contents                                               | Needs `three` |
| ----------------------------- | ------------------------------------------------------ | ------------- |
| `@fakl-code/pt-loader`        | `PTLoader`, the three.js build layer, everything below | yes           |
| `@fakl-code/pt-loader/viewer` | `PTViewer` — a ready-made canvas                       | yes           |
| `@fakl-code/pt-loader/core`   | parsers and image decoders only                        | **no**        |

Use `/core` inside a Web Worker, in Node, or in tests.

---

## Step 1 — prepare the assets

**This step is mandatory.** Skipping it produces a site that works locally and
breaks in production.

Copy the game's asset folders (`image/`, `char/`, `field/`, …) to an asset
directory. If the files are private, keep that directory **outside** the web
server's public/static root and expose it only through an authenticated route.
Then run:

```bash
# 1. Convert textures to PNG. Decrypts the BMP/TGA headers, cuts download size,
#    and removes the JS image decoder from the hot path.
npx pt-assets textures ./public/pt-assets --replace

# 2. Build the path index. REQUIRED.
npx pt-assets manifest ./public/pt-assets --out ./public/pt-assets/manifest.json
```

### Why the manifest is not optional

Texture names inside `.smd` files are bare basenames (`"rock02.bmp"`), and the
original assets mix `.BMP`, `.Bmp` and `.bmp` freely — Windows does not care
about case, and an HTTP server does. The manifest maps a lower-cased logical
path to the real path on disk:

```json
{
  "field/forest/rock02.bmp": "field/Forest/Rock02.png",
  "rock02.bmp": "field/Forest/Rock02.png"
}
```

Without it an unpredictable fraction of your models render with a magenta
checker texture — deliberately loud, so you notice.

### Other CLI commands

```bash
npx pt-assets decrypt ./public/pt-assets   # patch BMP/TGA headers in place, keep the format
npx pt-assets inspect  path/to/model.smd   # print structure; use this first when a model fails
```

`inspect` is the fastest way to diagnose a bad file:

```
PAT3D  imp.smd  (184232 bytes)
  version    "SMD Ver 0.66"  [0.66 layout]
  objects    3
  materials  4
  [ 0] Body                     v= 1242 f= 2104 rot=0 pos=0 scl=0 [skinned]
  mat[ 0] blend=0 type=0 opacity=1 transp=0.00 two=1 use=0x0  imp_body.tga
```

---

## Step 2 — use the loader

### A. You already have a three.js scene

```js
import * as THREE from 'three';
import { PTLoader } from '@fakl-code/pt-loader';

const manifest = await PTLoader.loadManifest('/pt-assets/manifest.json');
const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest });

const item = await loader.loadModel('image/Sinimage/Items/DropItem/it0123.smd');
scene.add(item);

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  loader.update(clock.getElapsedTime()); // scrolling water, torches, wind
  renderer.render(scene, camera);
});
```

`loader.update()` is only needed if your assets include animated materials. It
is cheap and safe to call unconditionally.

### B. You just want a canvas showing a model

```js
import { PTViewer } from '@fakl-code/pt-loader/viewer';

const viewer = new PTViewer('#item-canvas', {
  baseUrl: '/pt-assets/',
  manifest: await fetch('/pt-assets/manifest.json').then((r) => r.json()),
  autoRotate: true,
});

await viewer.show('image/Sinimage/Items/DropItem/it0123.smd');
```

The container element must have a non-zero size — `PTViewer` fills it. Call
`viewer.dispose()` when the component unmounts.

### Protecting models and textures

Browser-side code cannot make a rendered asset impossible to extract: an
authorized browser must receive the model bytes and upload the decoded texture
to the GPU. DevTools will therefore always show that a request happened, and a
determined authorized user can capture the response. Encryption or obfuscation
with a key shipped to the browser only makes that process less convenient.

The loader also applies defensive limits by default: 64 MiB per model/map/
animation response, 32 MiB per texture response, 16 megapixels per decoded
texture, 4 MiB per manifest and 64 MiB of retained input-buffer cache. Tune
these limits for trusted, larger assets rather than disabling them globally.
Logical asset paths are required to be relative and reject traversal, absolute
filesystem paths and external URLs before a request is made.

What can and should be enforced is **server-side access control**. Do not place
private assets under `public/`, a public bucket, or a CDN URL that works without
credentials. Route every manifest, model, skeleton, animation and texture
request through a backend that:

1. authenticates the session and checks that it may read the requested asset;
2. rejects traversal and maps an allow-listed logical path to a file/object;
3. returns `401` or `403` when the check fails;
4. sends `Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`;
5. uses an HttpOnly, Secure, SameSite session cookie when possible.

`requestInit` is applied to **every** request made by `PTLoader`, including
textures. For a same-origin backend with an HttpOnly session cookie:

```js
const protectedRequest = {
  credentials: 'same-origin',
  cache: 'no-store',
};

const manifest = await PTLoader.loadManifest(
  '/api/pt-assets/manifest.json',
  fetch,
  protectedRequest,
);

const loader = new PTLoader({
  baseUrl: '/api/pt-assets/',
  manifest,
  requestInit: protectedRequest,
});
```

The callback form is evaluated immediately before each request and supports
short-lived tokens:

```js
const loader = new PTLoader({
  baseUrl: '/api/pt-assets/',
  manifest,
  requestInit: async ({ path, kind }) => ({
    cache: 'no-store',
    headers: { Authorization: `Bearer ${await getAssetToken(path, kind)}` },
  }),
});
```

After logout, call `loader.dispose()` and ensure the backend invalidates the
session/token. CORS and `Referer` checks are useful supporting controls, but are
not authorization by themselves.

### Private server-rendered previews

If a public product page must show the **original** model with small camera
interactions while keeping the model and textures out of the browser, the
normal `PTLoader` browser flow cannot satisfy that requirement: a browser-side
renderer must receive the bytes it uploads to WebGL. Use the separate preview
contract instead. The server loads the private asset and returns only rendered
image frames.

```js
import { PTPreviewClient, PTPreviewViewer } from '@fakl-code/pt-loader/preview';

const client = new PTPreviewClient({
  endpoint: '/api/previews',
  requestInit: { credentials: 'include', cache: 'no-store' },
});

const image = document.querySelector('#item-preview');
const preview = new PTPreviewViewer(image, { client });
await preview.open('item_123', { width: 640, height: 480 });

// Drag to orbit, right-drag/Shift+drag to pan and wheel to zoom.
// Only image frames reach the browser; the viewer coalesces requests while
// the server is rendering.

preview.dispose();
```

`PTPreviewViewer` is the reusable interaction layer for this contract. It
owns pointer capture, disables the browser's native image drag, handles touch
and wheel input, and ignores stale frames after a session is replaced. Use
`PTPreviewClient` directly only when the application needs a custom input
surface or transport.

The `pt-preview-v1` contract is intentionally asset-agnostic:

1. `POST /api/previews/sessions` receives an opaque `assetId`, never a file
   path. It returns a short-lived `sessionId`.
2. `POST /api/previews/sessions/:id/render` receives a small JSON camera/state
   object and must return `image/webp`, `image/jpeg`, `image/avif` or `image/png`.
   The client rejects other content types and frames above its configured size
   limit.
3. `DELETE /api/previews/sessions/:id` closes the session.

The server must authenticate or rate-limit session creation, resolve the opaque
ID through an allowlist, enforce expiry and ownership, and render with the
original assets kept outside the public/static root. Do not return manifests,
model files, texture files, signed asset URLs or arbitrary paths from these
endpoints. For fluid interaction, the same contract can be backed by a
WebSocket or WebRTC transport; the HTTP client is the simple reference
transport.

For a framework-neutral Fetch API handler, use the Node-only entry point:

```js
import { createPreviewHandler } from '@fakl-code/pt-loader/preview-server';

const handlePreview = createPreviewHandler({
  authenticate: (request) => request.headers.get('x-user'),
  resolveAsset: ({ assetId }) => privateAssetStore.lookup(assetId),
  renderFrame: async ({ asset, state, viewport }) => ({
    // Load `asset` with PTLoader/three in the private renderer and return pixels.
    body: await renderPrivateFrame(asset, state, viewport),
    contentType: 'image/webp',
  }),
});
```

Adapt your web framework's request and response objects to the standard Fetch
API at the boundary. `resolveAsset` may return any private server-side value;
the handler only serialises the frame returned by `renderFrame`.

`PTLoader` and `PTViewer` remain unchanged for authorized browser-side loading.
The preview client is an opt-in, separate entry point for deployments where
asset confidentiality matters more than local WebGL rendering.

#### Published JavaScript and source maps

The npm package exposes minified files from `dist/`, does not publish `src/`,
and emits no `.map` files or `sourceMappingURL` comments. Your application build
can still create its own source map, so keep source maps disabled in the site's
production bundler configuration. DevTools can always display and pretty-print
the JavaScript actually delivered to the browser; minification reduces source
disclosure but is not a security boundary.

### Publishing releases to npm and GitHub

Every push to `main` starts `.github/workflows/publish.yml`. The workflow reads
the latest published version, increments the patch number in its isolated CI
workspace, validates the package, and publishes that version to npm. This keeps
the protected `main` branch unchanged while still creating a new npm version
for every deploy. After npm accepts the package, the same job creates a matching
GitHub Release and tag with generated notes. Pushes to other branches do not
publish. The workflow also supports manually dispatching an existing release
tag (for example, to retry a publish).

Before the first automated publish, create a granular npm access token with
package publish permission and the **bypass 2FA** option. Add it to the GitHub
repository as the `NPM_TOKEN` Actions secret. The workflow passes that secret
only to the publish command; it is never committed. Legacy npm tokens are not
accepted for this use case. Trusted Publishing/OIDC can be enabled later as a
long-lived-token-free alternative once the package exists on npm.

Every package, public-type, build, CI or release commit must include a
documentation change. `npm run check` and GitHub CI enforce this rule; see
[`AGENTS.md`](./AGENTS.md) and [`CHANGELOG.md`](./CHANGELOG.md). Do not publish
an ad-hoc local build: merge to protected `main` and let the workflow publish
npm and create the GitHub Release together.

### C. An animated character

```js
const character = await loader.loadCharacter('char/monster/death_knight/death_knight.inx');
scene.add(character.object);

const mixer = character.createMixer();
character.play('Idle', mixer);

console.log(character.clipNames);
// ['Full', 'Idle', 'Walk', 'Run', 'Attack', 'Attack.1', 'Damage', 'Die', ...]

renderer.setAnimationLoop(() => {
  mixer.update(clock.getDelta());
  loader.update(clock.getElapsedTime());
  renderer.render(scene, camera);
});
```

Pass the `.inx` path. A `.ini` or `.in` path also works — the extension is
swapped, because the game compiles those text scripts into the binary index.

### D. React (react-three-fiber)

```jsx
import { useEffect, useState } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { PTLoader } from '@fakl-code/pt-loader';

const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest });

function PTModel({ src }) {
  const [object, setObject] = useState(null);

  useEffect(() => {
    let alive = true;
    loader.loadModel(src).then((o) => (alive ? setObject(o) : loader.release(o)));
    return () => {
      alive = false;
    };
  }, [src]);

  useFrame((state) => loader.update(state.clock.elapsedTime));
  return object ? <primitive object={object} /> : null;
}
```

### E. A map

```js
const map = await loader.loadStage('field/forest/forest.smd');
scene.add(map);

// Optional: an invisible mesh of collidable faces, for raycasting.
const collision = await loader.loadCollision('field/forest/forest.smd');
scene.add(collision);
```

Map files are always at least 262 KB — most of it is a dead spatial grid the
parser skips. Consider `useWorker: true` so parsing does not drop frames:

```js
const loader = new PTLoader({ baseUrl: '/pt-assets/', manifest, useWorker: true });
```

If the worker cannot start, the loader logs a warning and falls back to the main
thread automatically. Nothing breaks.

### F. Picking a surface (the texture picker)

Click a surface to learn which texture it uses, and outline every other surface
in the scene that shares it — the texture-picker behaviour of the original
FieldBox tool.

```js
const off = viewer.onPick((hit) => {
  if (!hit) return void (info.textContent = '');
  info.textContent = `${hit.textureName} — ${hit.siblings.length} other surfaces`;
});

// later: off();
```

`onPick` handles the fiddly parts for you: dragging orbits the camera instead of
selecting, clicks land on the surface a person actually sees (a hit on a
transparent texel of a fence passes through to whatever is behind it), and the
wireframe overlay follows skeletal animation on skinned meshes.

The result carries everything the material knows:

```js
{
  mesh, point, uv, distance,
  textureName: 'rock02.bmp',
  textureNames: ['rock02.bmp', 'light01.bmp'],   // [0] diffuse, [1] lightmap
  materialIndex, nodeName, blendType, useState, meshState,
  mapOpacity, transparency, twoSide,
  siblings: [Mesh, Mesh, ...]                    // same texture, elsewhere
}
```

Swapping the texture on everything that uses it is then two lines:

```js
viewer.onPick(async (hit) => {
  if (!hit) return;
  const next = await viewer.loader.textures.load('field/forest/', 'rock07.bmp');
  for (const m of [hit.mesh, ...hit.siblings]) m.material.map = next;
});
```

Driving your own camera and input instead of `PTViewer`:

```js
import { PTLoader, pointerToNDC, PTHighlight } from '@fakl-code/pt-loader';

const highlight = new PTHighlight();

canvas.addEventListener('click', (event) => {
  const hit = loader.pick(model, camera, pointerToNDC(event, canvas));
  highlight.show(hit); // pass null to clear
});
```

Outline colours are configurable — `new PTViewer(el, { highlight: { color, siblingColor, xray } })`
or `new PTHighlight({ ... })`. `xray` defaults to `true` so siblings behind walls
are still findable, which is the point of the sibling highlight.

---

## API

### `new PTLoader(options)`

| Option                | Type                    | Default | Meaning                              |
| --------------------- | ----------------------- | ------- | ------------------------------------ |
| `baseUrl`             | `string`                | `''`    | Prefix for every request             |
| `manifest`            | `object \| Map \| null` | `null`  | Output of `pt-assets manifest`       |
| `fetch`               | `typeof fetch`          | global  | Custom fetch implementation          |
| `requestInit`         | `object \| function`    | —       | Auth options for every asset         |
| `textureCache`        | `TextureCache`          | new one | Share a cache between loaders        |
| `useWorker`           | `boolean`               | `false` | Parse off the main thread            |
| `maxAssetBytes`       | `number`                | 64 MiB  | Maximum model/map/animation response |
| `maxManifestBytes`    | `number`                | 4 MiB   | Maximum manifest response            |
| `maxBufferCacheBytes` | `number`                | 64 MiB  | Input-buffer cache budget            |
| `options`             | `PTBuildOptions`        | `{}`    | Defaults for every build             |

**Methods**

| Method                                             | Returns                 | Notes                                                |
| -------------------------------------------------- | ----------------------- | ---------------------------------------------------- |
| `loadModel(path, opts?)`                           | `Promise<Group>`        | Items, weapons, props                                |
| `loadCharacter(path, opts?)`                       | `Promise<PTCharacter>`  | Mesh + skeleton + clips                              |
| `loadStage(path, opts?)`                           | `Promise<Group>`        | Maps                                                 |
| `loadCollision(path, opts?)`                       | `Promise<Mesh \| null>` | Invisible, indexed                                   |
| `pick(root, camera, pointer, opts?)`               | `PTPickResult \| null`  | Raycast + material metadata                          |
| `update(elapsedSeconds)`                           | `void`                  | Call once per frame                                  |
| `release(root)`                                    | `void`                  | Dispose one object's GPU resources                   |
| `dispose()`                                        | `void`                  | Dispose everything, terminate the worker             |
| `setManifest(m)`                                   | `void`                  | Swap texture packs at runtime                        |
| `parsePAT3D/parseSTAGE3D/parseINX(path)`           | `Promise<object>`       | Raw parsed data                                      |
| `loadManifest(url)` / `PTLoader.loadManifest(...)` | `Promise<object>`       | Fetch a bounded manifest (instance also installs it) |

`loadModel` and `loadStage` accept `{ textureFolder }` to look textures up
somewhere other than the model's own folder — this is how you swap texture packs
without touching the model files.

### `PTCharacter`

```ts
{
  object: Group                              // add this to your scene
  clips: Record<string, AnimationClip>       // 'Idle', 'Walk', 'Attack', 'Full', ...
  clipNames: string[]
  reversed: Set<string>                      // clips authored to play backwards
  byState: Record<number, string>            // MotionInfo.state -> clip name
  skeleton: Skeleton | null
  inx: PTInx | null
  createMixer(): AnimationMixer
  play(name, mixer?): AnimationAction | null // handles `reversed` for you
}
```

### `new PTViewer(target, options)`

`target` is an element or a CSS selector. Options: `baseUrl`, `manifest`,
`fetch`, `requestInit`, `loader`, `background`, `autoRotate`,
`autoRotateSpeed`, `grid`, `fov`, `exposure`, `options`.

| Method / property                                    | Meaning                                                   |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `show(path, { kind, clip, frame })`                  | `kind` is `'model'` (default), `'character'` or `'stage'` |
| `play(name, { fade })`                               | Cross-fade to another clip                                |
| `clipNames`                                          | Clips on the current character                            |
| `onPick(cb, opts?)`                                  | Select surfaces on click; returns an unsubscribe function |
| `pick(event \| ndc, opts?)`                          | One-off raycast, no highlight                             |
| `showHighlight(target)` / `clearHighlight()`         | Drive the outline manually                                |
| `frameObject(obj)`                                   | Refit the camera                                          |
| `clear()` / `dispose()`                              | Teardown                                                  |
| `scene`, `camera`, `renderer`, `loader`, `highlight` | Escape hatches                                            |

Controls: drag to orbit, wheel or pinch to zoom, right-drag or shift-drag to pan,
click to pick (once `onPick` is wired).

### Metadata on every object

Each mesh carries the original game material flags. This is what `pickAt` reads,
and what makes texture swapping and surface inspection possible:

```js
mesh.userData.pt;
// { objectIndex, nodeName, materialIndex, blendType, textureType, useState,
//   meshState, mapOpacity, transparency, twoSide, windMeshBottom,
//   textureNames: ['rock02.bmp'], animTextureNames: [] }
```

Groups carry `userData.ptUpdate(time)`, `ptAnimators`, and for maps
`ptLights` / `ptRect`; for characters, `ptSkeleton` and `ptBones`.

---

## Build options

Pass as `new PTLoader({ options })` or per call as `loadModel(path, { options })`.

| Option            | Default      | Meaning                                                                                                                                                              |
| ----------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upAxisFix`       | `true`       | Apply the −90° X rotation mapping the game's Z-up to three.js's Y-up                                                                                                 |
| `objectTransform` | `'matrix'`   | `'matrix'` transforms vertices by the bind matrix; `'trs'` uses the decomposed transform; `'both'` reproduces the original renderer; `'none'` leaves raw coordinates |
| `smoothNormals`   | `false`      | Average normals across shared vertices instead of flat shading                                                                                                       |
| `bindInverses`    | `'pose'`     | How inverse-bind matrices are derived; see below                                                                                                                     |
| `lighting`        | `'unshaded'` | `'unshaded'` → `MeshBasicMaterial` (matches the game); `'lambert'` reacts to scene lights                                                                            |
| `alphaTest`       | `0.5`        | Cutout threshold                                                                                                                                                     |
| `vertexColors`    | `false`      | Feed baked map vertex colours into the geometry (stage only)                                                                                                         |

**`lighting`.** The game's textures already have shadow baked in and the
original engine renders unshaded. `'unshaded'` is the faithful choice; adding
PBR lighting washes everything out. Never use `MeshStandardMaterial` here.

**`objectTransform`.** The reference Java renderer applies both the bind matrix
_and_ a decomposed TRS, and its own source marks that with a `FIXME`. For single
-object props and items `'matrix'` is correct. If a model renders offset from
where you expect, try `'trs'`, then `'both'`.

**`bindInverses`.** `'pose'` derives inverse-bind matrices from the bone
hierarchy — self-consistent by construction and correct for every file tested.
`'matrix'` uses the file's own `transformInvert` instead. Only reach for it if a
character renders in a visibly broken rest pose.

---

## Contracts you must not break

These are the invariants the package maintains. Violating one produces a subtle
visual bug rather than an error.

**1. Textures are bottom-up with `flipY = false`.**
Decoded RGBA has row 0 at the _bottom_ of the image, matching OpenGL, and UVs
carry a `1 - v` flip. If you build a texture yourself and hand it to
`createMaterial`, match that convention or the texture appears vertically
mirrored.

**2. Lightmaps use the `uv1` attribute and `texture.channel = 1`.**
Set both if you attach a lightmap manually.

**3. Do not re-enable mipmaps on cutout materials.**
Materials with `mapOpacity` (fences, foliage, railings) have mipmaps disabled on
purpose. Mipmaps average the alpha channel, so at distance a 0/1 alpha mask
drifts past the alpha test and the fence becomes a solid wall.

**4. Cutout materials stay in the opaque queue.**
`transparent = false` with `alphaTest = 0.5` is correct and intentional. Setting
`transparent = true` buys back-to-front sorting you do not need and introduces
depth artefacts.

**5. Rotation keyframes in the source format are deltas.**
The package already accumulates them. If you write your own animation code
against `parsePAT3D` output, `obj.rotTrack` entries are relative to the previous
key, not absolute. Treating them as absolute freezes the character in its first
pose.

**6. Positions and scales in the produced clips are absolute.**
The source format stores them relative to the bind pose (jMonkeyEngine
convention); the package converts them, because three.js expects absolute local
values.

**7. Geometry is non-indexed.**
UVs are per-face in the source format, so the same vertex can need different
UVs. Do not call `mergeVertices()` on the result without re-splitting by UV.

**8. Skinned meshes are bound after the hierarchy is final.**
You may freely move, rotate and scale the returned group afterwards — three.js
recomputes `bindMatrixInverse` each frame in attached bind mode. Do not call
`.bind()` again yourself.

---

## Troubleshooting

| Symptom                                      | Cause                                                                  | Fix                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Magenta/black checker texture                | Name not in the manifest                                               | Re-run `pt-assets manifest`; check the console for the unresolved name                                                                |
| `... ended at offset N, expected M`          | Misaligned stream, usually a corrupt or non-PT file                    | Run `pt-assets inspect` on the file                                                                                                   |
| `unexpected .inx size`                       | Not a valid `.inx`, or a variant this package does not know            | Confirm the file is 67,084 or 95,268 bytes                                                                                            |
| Model loads but is invisible                 | Every material is `NOTVIEW`, or the camera is inside it                | `pt-assets inspect`; check `use=0x400`                                                                                                |
| Texture is vertically mirrored               | A hand-built texture with the wrong `flipY`                            | See contract 1                                                                                                                        |
| Fences look solid from far away              | Mipmaps re-enabled on a cutout material                                | See contract 3                                                                                                                        |
| Objects behind glass disappear               | `depthWrite` re-enabled on a transparent material                      | Leave `depthWrite = false`                                                                                                            |
| Character frozen in one pose                 | Custom animation code treating deltas as absolute                      | See contract 5                                                                                                                        |
| Character renders but limbs are scrambled    | Bind-pose mismatch                                                     | Try `bindInverses: 'matrix'`                                                                                                          |
| Everything washed out                        | `lighting: 'lambert'` plus bright scene lights                         | Use `'unshaded'`                                                                                                                      |
| `instanceof` checks failing on three objects | Two copies of `three` in the bundle, almost always from a `file:` link | `npm ls three` to confirm, then `resolve.dedupe: ['three']` — see [If you link the package locally](#if-you-link-the-package-locally) |
| Frame drops when loading a map               | Main-thread parsing                                                    | `useWorker: true`                                                                                                                     |

---

## Node / offline pipeline

`@fakl-code/pt-loader/core` runs in Node with no three.js and no DOM, which is
what makes an offline glTF/GLB pipeline practical without maintaining a second
parser:

```js
import { parsePAT3D, parseINX, decodeImage } from '@fakl-code/pt-loader/core';
import { readFile } from 'node:fs/promises';

const pat = parsePAT3D(await readFile('imp.smd'));
const tex = decodeImage(await readFile('imp_body.tga'), 'imp_body.tga');
// tex.data is bottom-up RGBA; flip rows when writing PNG/KTX2.
```

For a full conversion, feed the parsed data to `@gltf-transform/core`, then
apply `weld()` (reindexes the non-indexed mesh, typically −40…60% vertices),
`dedup()` and `draco()`. Keep the game's material flags in each primitive's
`extras` and reapply them on the client with `createMaterial`, so blend and
cutout logic has one source of truth in both paths.

---

## Limitations

Stated plainly, so you do not discover them at runtime:

- **BMP RLE4/RLE8 are implemented but untested against real game assets.** The
  shipped textures are uncompressed 24-bit; if you hit an RLE file and it
  decodes wrong, that is the first place to look.
- **`NameA` (separate alpha texture) is parsed but not applied.** No shipped
  asset observed using it. The field is available on `material.textures[i].nameAlpha`.
- **Map lights are parsed but not converted into three.js lights.** They are
  exposed on `group.userData.ptLights` for you to place; the game's baked
  lightmaps already carry the lighting.
- **`BlendType` 3 (`SHADOW`) and 6 (`INVSHADOW`) render opaque**, matching the
  reference renderer, which also does not implement them.
- **`.ase` models are not supported.** This package reads the binary `.smd` /
  `.smb` / `.inx` family only.
- **The `objectTransform` and `bindInverses` ambiguities are real**, inherited
  from the source format; see [Build options](#build-options). Both have working
  escape hatches.

---

## Tests

```bash
npm install
npm test
npm run check
```

83 tests cover byte offsets against synthetic fixtures, the crypto
round-trip, both image decoders, the 0.66 layout quirk, pointer relinking, the
material rules, skinning, the rotation-delta accumulation, and surface picking.

`npm run check` also performs a dry run of the npm tarball, so accidental files
are caught before release. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the
architecture rules and pull-request checklist. Security reports belong in a
[private advisory](./SECURITY.md), not a public issue.

## Contributing and support

Contributions are welcome through reviewed pull requests. Read the
[contribution guide](./CONTRIBUTING.md) and [governance policy](./GOVERNANCE.md)
before starting a change. Usage questions belong in
[GitHub Discussions](https://github.com/FaKL-Code/pt-loader/discussions), while
the issue tracker uses structured forms for reproducible bugs and feature
requests. See [SUPPORT.md](./SUPPORT.md) for details.

GitHub Sponsors support is configured through `.github/FUNDING.yml`; the
Sponsor button becomes available when the maintainer's Sponsors profile is
active.

## License

MIT — see [LICENSE](./LICENSE).

Priston Tale is a trademark of its respective owners. This independent project
is not affiliated with or endorsed by the game's publisher or developer. You
are responsible for using game assets in accordance with the rights and terms
that apply to you; this repository contains code and synthetic test fixtures
only.
