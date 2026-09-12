#!/usr/bin/env node
/**
 * pt-assets — asset preparation for @jpstale/pt-loader.
 *
 * Zero dependencies: PNG encoding uses node:zlib.
 *
 *   pt-assets manifest <dir> [--out manifest.json]
 *   pt-assets textures <dir> [--out <dir>] [--format png] [--replace]
 *   pt-assets decrypt  <dir>
 *   pt-assets inspect  <file.smd|.smb|.inx>
 */
import { readdir, readFile, writeFile, stat, mkdir, unlink } from 'node:fs/promises';
import { join, relative, dirname, extname, basename, sep } from 'node:path';
import { deflateSync } from 'node:zlib';

import { decodeImage } from '../src/textures/decode.js';
import { decryptImage } from '../src/io/crypto.js';
import { parsePAT3D } from '../src/formats/pat3d.js';
import { parseSTAGE3D } from '../src/formats/stage3d.js';
import { parseINX } from '../src/formats/inx.js';
import { SIZES } from '../src/formats/constants.js';

const USAGE = `
pt-assets — asset preparation for @jpstale/pt-loader

  pt-assets manifest <dir> [--out manifest.json]
      Walk <dir> and write a lower-cased path index. Required in production:
      texture names inside .smd files do not match the on-disk casing.

  pt-assets textures <dir> [--out <dir>] [--format png] [--replace]
      Decrypt and convert every .bmp/.tga to PNG. Cuts download size and
      removes the JS decoder from the hot path.

  pt-assets decrypt <dir>
      Patch .bmp/.tga headers in place, leaving them as ordinary image files.

  pt-assets inspect <file>
      Print a structural summary of a .smd, .smb or .inx. Use this first when
      a model fails to load.
`;

/** Formats `pt-assets textures` can produce. */
const CONVERTED_EXTENSIONS = new Set(['png', 'webp', 'jpg', 'jpeg', 'avif']);
/** Extensions that models reference and that conversion replaces. */
const SOURCE_EXTENSIONS = ['bmp', 'tga'];

// --------------------------------------------------------------- helpers ---

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function toPosix(p) {
  return p.split(sep).join('/');
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

// ------------------------------------------------------------ PNG writer ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  out.writeUInt32BE(crc32(crcInput), data.length + 8);
  return out;
}

/**
 * Encode bottom-up RGBA into a PNG buffer.
 * PNG scanlines run top-down, so rows are reversed on the way out.
 */
function encodePNG(data, width, height, hasAlpha) {
  const channels = hasAlpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y; // flip: source is bottom-up
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const s = (srcRow * width + x) * 4;
      const d = dst + 1 + x * channels;
      raw[d] = data[s];
      raw[d + 1] = data[s + 1];
      raw[d + 2] = data[s + 2];
      if (hasAlpha) raw[d + 3] = data[s + 3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = hasAlpha ? 6 : 2; // colour type: RGBA or RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------- commands ---

async function cmdManifest(dir, flags) {
  const outPath = typeof flags.out === 'string' ? flags.out : join(dir, 'manifest.json');
  const files = await walk(dir);

  const manifest = {};
  const byBase = new Map();

  for (const file of files) {
    const rel = toPosix(relative(dir, file));
    if (rel === toPosix(relative(dir, outPath))) continue;
    manifest[rel.toLowerCase()] = rel;

    const base = basename(rel).toLowerCase();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(rel);
  }

  // Basename-only fallback, added only when unambiguous. Texture references in
  // .smd files are bare names, and some assets live outside their model folder.
  let ambiguous = 0;
  for (const [base, paths] of byBase) {
    if (paths.length === 1) {
      if (!(base in manifest)) manifest[base] = paths[0];
    } else ambiguous++;
  }

  // Models keep referencing `rock02.tga` after `pt-assets textures` has written
  // `rock02.png`. Alias the original extensions onto the converted file so the
  // reference still resolves — but never shadow a real file of that name.
  let aliases = 0;
  for (const [key, real] of Object.entries({ ...manifest })) {
    const dot = key.lastIndexOf('.');
    if (dot < 0) continue;
    if (!CONVERTED_EXTENSIONS.has(key.slice(dot + 1))) continue;
    const stem = key.slice(0, dot);
    for (const ext of SOURCE_EXTENSIONS) {
      const alias = `${stem}.${ext}`;
      if (!(alias in manifest)) {
        manifest[alias] = real;
        aliases++;
      }
    }
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(manifest, null, 0));

  console.log(`pt-assets: indexed ${files.length} files -> ${outPath}`);
  console.log(
    `           ${Object.keys(manifest).length} keys ` +
      `(${aliases} .bmp/.tga aliases for converted images), ` +
      `${ambiguous} ambiguous basenames skipped`,
  );
}

async function cmdTextures(dir, flags) {
  const outDir = typeof flags.out === 'string' ? flags.out : dir;
  const replace = flags.replace === true;
  const files = (await walk(dir)).filter((f) => /\.(bmp|tga)$/i.test(f));

  let ok = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const buf = await readFile(file);
      const u8 = new Uint8Array(buf);
      const { width, height, data, hasAlpha } = decodeImage(u8, file);

      const rel = relative(dir, file);
      const target = join(outDir, rel.slice(0, rel.length - extname(rel).length) + '.png');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, encodePNG(data, width, height, hasAlpha));

      if (replace) await unlink(file);
      ok++;
    } catch (err) {
      failed++;
      console.warn(`  ! ${relative(dir, file)}: ${err.message}`);
    }
  }

  console.log(
    `pt-assets: converted ${ok} texture(s)${failed ? `, ${failed} failed` : ''} -> ${outDir}`,
  );
  if (ok > 0)
    console.log('           re-run `pt-assets manifest` so the index picks up the .png files');
}

async function cmdDecrypt(dir) {
  const files = (await walk(dir)).filter((f) => /\.(bmp|tga)$/i.test(f));
  let changed = 0;

  for (const file of files) {
    const buf = await readFile(file);
    const u8 = new Uint8Array(buf);
    const first = [u8[0], u8[1]];
    try {
      decryptImage(u8, file);
    } catch (err) {
      console.warn(`  ! ${relative(dir, file)}: ${err.message}`);
      continue;
    }
    if (u8[0] !== first[0] || u8[1] !== first[1]) {
      await writeFile(file, Buffer.from(u8));
      changed++;
    }
  }
  console.log(`pt-assets: decrypted ${changed} of ${files.length} file(s) in place`);
}

async function cmdInspect(file) {
  const buf = await readFile(file);
  const ext = extname(file).toLowerCase();
  const u8 = new Uint8Array(buf);

  if (ext === '.inx') {
    const inx = parseINX(u8);
    console.log(`INX  ${basename(file)}  (${buf.length} bytes, ${inx.kpt ? 'KPT' : 'classic'})`);
    console.log(`  modelFile       ${inx.modelFile}`);
    console.log(`  motionFile      ${inx.motionFile}`);
    console.log(`  motionLinkFile  ${inx.motionLinkFile || '(none)'}`);
    console.log(`  clips           ${inx.motions.length} motion, ${inx.talkMotions.length} talk`);
    for (const m of inx.motions) {
      console.log(
        `    ${m.name.padEnd(16)} state=0x${m.state.toString(16).padStart(3, '0')} ` +
          `ticks ${m.effectiveStartTick}..${m.endTick}${m.reversed ? ' (reversed)' : ''}`,
      );
    }
    return;
  }

  // A STAGE3D file is at least the header plus the 262 KB Stage struct.
  const looksLikeStage = buf.length > SIZES.SMD_FILE_HEADER + SIZES.STAGE;
  let parsed = null;
  let kind = '';

  if (looksLikeStage) {
    try {
      parsed = parseSTAGE3D(u8);
      kind = 'STAGE3D';
    } catch {
      /* fall through to PAT3D */
    }
  }
  if (!parsed) {
    parsed = parsePAT3D(u8);
    kind = 'PAT3D';
  }

  console.log(`${kind}  ${basename(file)}  (${buf.length} bytes)`);
  console.log(
    `  version    "${parsed.header.header}"${parsed.header.isVer066 ? '  [0.66 layout]' : ''}`,
  );
  console.log(`  objects    ${parsed.header.objCounter}`);
  console.log(`  materials  ${parsed.materialGroup?.materialCount ?? 0}`);

  if (kind === 'STAGE3D') {
    console.log(`  vertices   ${parsed.vertices.length}`);
    console.log(`  faces      ${parsed.faces.length}`);
    console.log(`  texLinks   ${parsed.texLinks.length}`);
    console.log(`  lights     ${parsed.lights.length}`);
  } else {
    for (let i = 0; i < parsed.objects.length; i++) {
      const o = parsed.objects[i];
      console.log(
        `  [${String(i).padStart(2)}] ${(o.nodeName || '(unnamed)').padEnd(24)} ` +
          `v=${String(o.nVertex).padStart(5)} f=${String(o.nFace).padStart(5)} ` +
          `rot=${o.tmRotCnt} pos=${o.tmPosCnt} scl=${o.tmScaleCnt}` +
          `${o.boneNames ? ' [skinned]' : ''}${o.nodeParent ? `  parent=${o.nodeParent}` : ''}`,
      );
    }
    if (parsed.maxFrame) {
      console.log(`  maxFrame   ${parsed.maxFrame}  (${(parsed.maxFrame / 4800).toFixed(2)} s)`);
    }
  }

  const mats = parsed.materialGroup?.materials ?? [];
  for (let i = 0; i < mats.length; i++) {
    const m = mats[i];
    if (m.inUse === 0) continue;
    const names = [...m.textures.map((t) => t.name), ...m.animTextures.map((t) => t.name)];
    console.log(
      `  mat[${String(i).padStart(2)}] blend=${m.blendType} type=${m.textureType} ` +
        `opacity=${m.mapOpacity} transp=${m.transparency.toFixed(2)} two=${m.twoSide} ` +
        `use=0x${(m.useState >>> 0).toString(16)}  ${names.join(', ') || '(no texture)'}`,
    );
  }
}

// ------------------------------------------------------------------ main ---

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, target] = positional;

  if (!command || flags.help) {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }
  if (!target) {
    console.error(`pt-assets: "${command}" needs a path argument\n${USAGE}`);
    process.exit(1);
  }

  const info = await stat(target).catch(() => null);
  if (!info) {
    console.error(`pt-assets: "${target}" does not exist`);
    process.exit(1);
  }

  switch (command) {
    case 'manifest':
      return cmdManifest(target, flags);
    case 'textures':
      return cmdTextures(target, flags);
    case 'decrypt':
      return cmdDecrypt(target);
    case 'inspect':
      return cmdInspect(target);
    default:
      console.error(`pt-assets: unknown command "${command}"\n${USAGE}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`pt-assets: ${err.stack ?? err.message}`);
  process.exit(1);
});
