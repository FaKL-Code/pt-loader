import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

test('published entry points use minified dist files and exclude source', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));

  assert.equal(pkg.name, '@fakl-code/pt-loader');
  assert.equal(pkg.exports['.'].import, './dist/index.js');
  assert.equal(pkg.exports['./core'].import, './dist/core.js');
  assert.equal(pkg.exports['./viewer'].import, './dist/viewer.js');
  assert.equal(pkg.exports['./preview'].import, './dist/preview.js');
  assert.equal(pkg.exports['./preview-server'].import, './dist/preview-server.js');
  assert.equal(pkg.bin['pt-assets'], 'dist/cli.js');
  assert.ok(pkg.files.includes('dist'));
  assert.ok(!pkg.files.includes('src'));
  assert.ok(!pkg.files.includes('bin'));
});

test('production build emits no source maps or source map references', async () => {
  const files = await walk(join(ROOT, 'dist'));
  assert.ok(files.length >= 5, `expected production artifacts, found ${files.length}`);
  assert.deepEqual(
    files.filter((file) => extname(file) === '.map'),
    [],
  );

  for (const file of files.filter((candidate) => extname(candidate) === '.js')) {
    const source = await readFile(file, 'utf8');
    assert.ok(!source.includes('sourceMappingURL'), `${file} references a source map`);
  }
});

test('built core entry point remains importable', async () => {
  const core = await import('../dist/core.js');
  assert.equal(typeof core.parsePAT3D, 'function');
  assert.equal(typeof core.decodeImage, 'function');
});

test('built private-preview entry point remains importable', async () => {
  const preview = await import('../dist/preview.js');
  assert.equal(preview.PT_PREVIEW_PROTOCOL, 'pt-preview-v1');
  assert.equal(typeof preview.PTPreviewClient, 'function');
});

test('built preview-server entry point remains importable', async () => {
  const server = await import('../dist/preview-server.js');
  assert.equal(typeof server.createPreviewHandler, 'function');
});
