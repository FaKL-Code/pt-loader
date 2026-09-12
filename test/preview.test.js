import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PTPreviewClient, PT_PREVIEW_PROTOCOL } from '../src/preview.js';
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
    resolveAsset: async ({ assetId }) => {
      requests.push(assetId);
      return { privatePath: `/srv/private/${assetId}.smd` };
    },
    renderFrame: async ({ asset, state }) => {
      assert.equal(asset.privatePath, '/srv/private/item_123.smd');
      assert.deepEqual(state, { camera: { azimuth: 1 } });
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
