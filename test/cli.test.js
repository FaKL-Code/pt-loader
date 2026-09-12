import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { buildBMP, buildPAT3D } from './helpers/write.js';
import { encryptBMP } from '../src/io/crypto.js';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pt-assets-'));
  mkdirSync(join(dir, 'field', 'Forest'), { recursive: true });
  return dir;
}

test('manifest indexes real paths and lower-cased keys', () => {
  const dir = fixtureDir();
  try {
    writeFileSync(
      join(dir, 'field', 'Forest', 'Rock02.BMP'),
      Buffer.from(
        new Uint8Array(
          buildBMP(2, 1, [
            [
              [255, 0, 0],
              [0, 255, 0],
            ],
          ]),
        ),
      ),
    );
    writeFileSync(
      join(dir, 'field', 'Forest', 'test.smd'),
      Buffer.from(new Uint8Array(buildPAT3D())),
    );

    run('manifest', dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

    assert.equal(manifest['field/forest/rock02.bmp'], 'field/Forest/Rock02.BMP');
    assert.equal(
      manifest['rock02.bmp'],
      'field/Forest/Rock02.BMP',
      'unambiguous basename fallback',
    );
    assert.equal(manifest['field/forest/test.smd'], 'field/Forest/test.smd');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest aliases .bmp/.tga onto converted images', () => {
  // After `pt-assets textures`, models still reference `rock02.tga` while the
  // file on disk is `rock02.png`. Without the alias every converted texture
  // silently falls back to the magenta checker.
  const dir = fixtureDir();
  try {
    writeFileSync(
      join(dir, 'field', 'Forest', 'rock02.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );

    run('manifest', dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

    assert.equal(manifest['field/forest/rock02.png'], 'field/Forest/rock02.png');
    assert.equal(manifest['field/forest/rock02.tga'], 'field/Forest/rock02.png');
    assert.equal(manifest['field/forest/rock02.bmp'], 'field/Forest/rock02.png');
    assert.equal(manifest['rock02.tga'], 'field/Forest/rock02.png', 'basename aliases too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifest never lets an alias shadow a real file', () => {
  const dir = fixtureDir();
  try {
    const bmp = Buffer.from(
      new Uint8Array(
        buildBMP(2, 1, [
          [
            [255, 0, 0],
            [0, 255, 0],
          ],
        ]),
      ),
    );
    writeFileSync(
      join(dir, 'field', 'Forest', 'rock02.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    writeFileSync(join(dir, 'field', 'Forest', 'rock02.bmp'), bmp);

    run('manifest', dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

    assert.equal(
      manifest['field/forest/rock02.bmp'],
      'field/Forest/rock02.bmp',
      'the real file wins',
    );
    assert.equal(
      manifest['field/forest/rock02.tga'],
      'field/Forest/rock02.png',
      'the free slot is aliased',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('textures converts an encrypted BMP into a valid PNG', () => {
  const dir = fixtureDir();
  try {
    const bmp = new Uint8Array(
      buildBMP(2, 2, [
        [
          [255, 0, 0],
          [0, 255, 0],
        ],
        [
          [0, 0, 255],
          [255, 255, 255],
        ],
      ]),
    );
    encryptBMP(bmp);
    writeFileSync(join(dir, 'field', 'Forest', 'Rock02.BMP'), Buffer.from(bmp));

    const out = run('textures', dir);
    assert.match(out, /converted 1 texture/);

    const png = readFileSync(join(dir, 'field', 'Forest', 'Rock02.png'));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.toString('ascii', 12, 16), 'IHDR');
    assert.equal(png.readUInt32BE(16), 2, 'width');
    assert.equal(png.readUInt32BE(20), 2, 'height');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inspect prints a structural summary of a model', () => {
  const dir = fixtureDir();
  try {
    const file = join(dir, 'test.smd');
    writeFileSync(file, Buffer.from(new Uint8Array(buildPAT3D())));

    const out = run('inspect', file);
    assert.match(out, /PAT3D/);
    assert.match(out, /objects\s+1/);
    assert.match(out, /materials\s+1/);
    assert.match(out, /test\.bmp/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
