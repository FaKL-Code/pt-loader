import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PTPreviewClient, PTPreviewViewer, PT_PREVIEW_PROTOCOL } from '../src/preview.js';
import { createPreviewHandler } from '../src/preview-server.js';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  };
}

function imageResponse(bytes, contentType = 'image/webp', status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      'content-type': contentType,
      'content-length': String(bytes.byteLength),
    }),
    arrayBuffer: async () => bytes.buffer,
  };
}

test('preview client sends opaque ids and accepts rendered frames only', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST' && url.endsWith('/sessions')) {
      return jsonResponse({
        protocol: PT_PREVIEW_PROTOCOL,
        sessionId: 'session_123',
        expiresAt: '2030-01-01T00:00:00Z',
      });
    }
    if (url.endsWith('/sessions/session_123/render')) {
      return imageResponse(new Uint8Array([1, 2, 3]));
    }
    if (init.method === 'DELETE') return jsonResponse({ ok: true });
    throw new Error(`unexpected request ${url}`);
  };

  const client = new PTPreviewClient({
    endpoint: '/api/previews',
    fetch: fetchImpl,
    requestInit: async ({ kind }) => ({
      credentials: 'include',
      headers: { Authorization: `Preview ${kind}` },
    }),
  });

  const session = await client.open('item_123', { width: 320, height: 240 });
  assert.equal(session.sessionId, 'session_123');
  const open = calls[0];
  assert.equal(open.url, '/api/previews/sessions');
  assert.equal(open.init.credentials, 'include');
  assert.equal(open.init.headers.get('authorization'), 'Preview preview');
  const openBody = JSON.parse(open.init.body);
  assert.deepEqual(openBody, {
    protocol: PT_PREVIEW_PROTOCOL,
    assetId: 'item_123',
    kind: 'model',
    viewport: { width: 320, height: 240, pixelRatio: 1 },
    options: {},
  });
  assert.ok(!open.init.body.includes('.smd'), 'the browser contract must not contain asset paths');

  const frame = await client.render({ camera: { azimuth: 0.5, distance: 4 } });
  assert.equal(frame.contentType, 'image/webp');
  assert.equal(frame.blob.size, 3);
  assert.ok(calls[1].url.endsWith('/sessions/session_123/render'));
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    protocol: PT_PREVIEW_PROTOCOL,
    state: { camera: { azimuth: 0.5, distance: 4 } },
  });

  await client.close();
  assert.equal(calls[2].init.method, 'DELETE');
  client.dispose();
});

test('preview client rejects paths, invalid frames and oversized frames', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/sessions')) {
      return jsonResponse({ protocol: PT_PREVIEW_PROTOCOL, sessionId: 's1' });
    }
    return imageResponse(new Uint8Array([1, 2, 3, 4]), 'application/octet-stream');
  };
  const client = new PTPreviewClient({ endpoint: '/preview', fetch: fetchImpl, maxFrameBytes: 3 });

  await assert.rejects(client.open('../private/item'), /opaque id/);
  assert.equal(calls.length, 0);

  await client.open('item_1');
  await assert.rejects(client.render(), /did not return an image/);

  const frameFetch = async (url, init) => {
    if (url.endsWith('/sessions'))
      return jsonResponse({ protocol: PT_PREVIEW_PROTOCOL, sessionId: 's2' });
    return imageResponse(new Uint8Array([1, 2, 3, 4]), 'image/webp');
  };
  const limited = new PTPreviewClient({
    endpoint: '/preview',
    fetch: frameFetch,
    maxFrameBytes: 3,
  });
  await limited.open('item_2');
  await assert.rejects(limited.render(), /exceeds maxFrameBytes/);
});

test('preview server binds sessions to a principal and never returns private assets', async () => {
  const requests = [];
  const handler = createPreviewHandler({
    basePath: '/api/previews',
    authenticate: async (request) => request.headers.get('x-user'),
    resolveAsset: async ({ assetId, viewport, options }) => {
      requests.push(assetId);
      assert.deepEqual(viewport, { width: 320, height: 240, pixelRatio: 1 });
      assert.deepEqual(options, {});
      return { privatePath: `/srv/private/${assetId}.smd` };
    },
    renderFrame: async ({ asset, state, signal }) => {
      assert.equal(asset.privatePath, '/srv/private/item_123.smd');
      assert.deepEqual(state, { camera: { azimuth: 1 } });
      assert.ok(signal instanceof AbortSignal);
      return { body: new Uint8Array([9, 8, 7]), contentType: 'image/webp' };
    },
  });

  const open = await handler(
    new Request('https://example.test/api/previews/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'buyer-1' },
      body: JSON.stringify({
        protocol: PT_PREVIEW_PROTOCOL,
        assetId: 'item_123',
        kind: 'model',
        viewport: { width: 320, height: 240, pixelRatio: 1 },
        options: {},
      }),
    }),
  );
  assert.equal(open.status, 200);
  const session = await open.json();
  assert.equal(requests[0], 'item_123');

  const render = await handler(
    new Request(`https://example.test/api/previews/sessions/${session.sessionId}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'buyer-1' },
      body: JSON.stringify({
        protocol: PT_PREVIEW_PROTOCOL,
        state: { camera: { azimuth: 1 } },
      }),
    }),
  );
  assert.equal(render.status, 200);
  assert.equal(render.headers.get('content-type'), 'image/webp');
  assert.deepEqual([...new Uint8Array(await render.arrayBuffer())], [9, 8, 7]);

  const otherUser = await handler(
    new Request(`https://example.test/api/previews/sessions/${session.sessionId}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user': 'buyer-2' },
      body: JSON.stringify({ protocol: PT_PREVIEW_PROTOCOL, state: {} }),
    }),
  );
  assert.equal(otherUser.status, 404);
});

test('preview server enforces bounded request bodies', async () => {
  const handler = createPreviewHandler({
    maxSessions: 1,
    authenticate: () => 'buyer-1',
    resolveAsset: () => ({ private: true }),
    renderFrame: () => ({ body: new Uint8Array([1]), contentType: 'image/webp' }),
  });

  const response = await handler(
    new Request('https://example.test/api/previews/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: PT_PREVIEW_PROTOCOL,
        assetId: 'item_123',
        kind: 'model',
        viewport: { width: 320, height: 240, pixelRatio: 1 },
        options: { padding: 'x'.repeat(70_000) },
      }),
    }),
  );
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
});

test('preview viewer owns pointer controls and coalesces server frames', async () => {
  const image = fakeImage();
  const states = [];
  const client = {
    open: async () => ({ sessionId: 's1', expiresAt: null }),
    render: async (state) => {
      states.push(state);
      return { blob: new Blob([1]), url: `blob:frame-${states.length}`, contentType: 'image/webp' };
    },
    dispose() {},
  };
  const viewer = new PTPreviewViewer(image, { client });

  await viewer.open('item_123');
  image.dispatch('pointerdown', pointer({ pointerId: 1, clientX: 100, clientY: 100 }));
  image.dispatch('pointermove', pointer({ pointerId: 1, clientX: 220, clientY: 80 }));
  image.dispatch('pointerup', pointer({ pointerId: 1, clientX: 220, clientY: 80 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await viewer.setTransform({ position: [1, 2, 3], rotation: [0, 0.1, 0], scale: 1.25 });

  assert.equal(image.draggable, false);
  assert.ok(viewer.camera.azimuth > 0.9);
  assert.ok(states.length >= 2);
  assert.deepEqual(states.at(-1).camera, viewer.camera);
  assert.deepEqual(states.at(-1).transform.position, [1, 2, 3]);
  assert.deepEqual(viewer.transform.scale, [1.25, 1.25, 1.25]);
  viewer.dispose();
});

test('preview viewer aborts a stale in-flight frame before rendering the latest state', async () => {
  const image = fakeImage();
  let calls = 0;
  let aborted = false;
  const client = {
    open: async () => ({ sessionId: 's1', expiresAt: null }),
    render: async (_state, { signal }) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      }
      return { blob: new Blob([1]), url: 'blob:latest', contentType: 'image/webp' };
    },
    dispose() {},
  };
  const viewer = new PTPreviewViewer(image, { client });
  await client.open();
  const first = viewer.requestRender();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await viewer.setCamera({ azimuth: 0.5 });
  await first;

  assert.equal(aborted, true);
  assert.equal(calls, 2);
  viewer.dispose();
});

function fakeImage() {
  const listeners = new Map();
  let captured = null;
  return {
    src: '',
    draggable: true,
    style: {},
    addEventListener(type, callback) {
      const list = listeners.get(type) ?? [];
      list.push(callback);
      listeners.set(type, list);
    },
    removeEventListener(type, callback) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((item) => item !== callback),
      );
    },
    dispatch(type, event) {
      for (const callback of listeners.get(type) ?? []) callback(event);
    },
    setPointerCapture(pointerId) {
      captured = pointerId;
    },
    hasPointerCapture(pointerId) {
      return captured === pointerId;
    },
    releasePointerCapture(pointerId) {
      if (captured === pointerId) captured = null;
    },
  };
}

function pointer(values) {
  return {
    pointerType: 'mouse',
    button: 0,
    preventDefault() {},
    ...values,
  };
}
