/**
 * Windows BMP decoder.
 *
 * Output is always **bottom-up RGBA**: row 0 of `data` is the bottom row of the
 * image. That matches OpenGL's texture layout, so the resulting texture is used
 * with `flipY = false` and the `1 - v` flip applied to the UVs — see
 * `build/geometry.js`. BMP already stores rows bottom-up, so the common path
 * is a straight copy.
 *
 * Supported: 1, 4, 8, 16, 24 and 32 bpp, BI_RGB, BI_BITFIELDS, BI_RLE8, BI_RLE4,
 * with BITMAPCOREHEADER, BITMAPINFOHEADER, and the V4/V5 extensions.
 */

const BI_RGB = 0;
const BI_RLE8 = 1;
const BI_RLE4 = 2;
const BI_BITFIELDS = 3;

/** Build a 5/6/8-bit-aware channel extractor from a bit mask. */
function maskToShiftScale(mask) {
  if (!mask) return null;
  let shift = 0;
  let m = mask;
  while ((m & 1) === 0) {
    m >>>= 1;
    shift++;
  }
  let bits = 0;
  while (m & 1) {
    m >>>= 1;
    bits++;
  }
  const max = (1 << bits) - 1;
  return { shift, mask, scale: max ? 255 / max : 0 };
}

/**
 * @param {Uint8Array} u8 full, already-decrypted BMP file
 * @returns {{width:number, height:number, data:Uint8Array, hasAlpha:boolean}}
 */
export function decodeBMP(u8, { maxPixels = 16 * 1024 * 1024 } = {}) {
  if (u8.length < 26 || u8[0] !== 0x42 || u8[1] !== 0x4d) {
    throw new Error('pt-loader: not a BMP (missing "BM" magic — was it decrypted?)');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const dataOffset = dv.getUint32(0x0a, true);
  const dibSize = dv.getUint32(0x0e, true);

  let width;
  let height;
  let bitCount;
  let compression = BI_RGB;
  let clrUsed = 0;
  let paletteEntrySize = 4;

  if (dibSize === 12) {
    // BITMAPCOREHEADER
    width = dv.getInt16(0x12, true);
    height = dv.getInt16(0x14, true);
    bitCount = dv.getUint16(0x18, true);
    paletteEntrySize = 3;
  } else if (dibSize >= 40) {
    width = dv.getInt32(0x12, true);
    height = dv.getInt32(0x16, true);
    bitCount = dv.getUint16(0x1c, true);
    compression = dv.getUint32(0x1e, true);
    clrUsed = dv.getUint32(0x2e, true);
  } else {
    throw new Error(`pt-loader: unsupported BMP DIB header size ${dibSize}`);
  }

  const topDown = height < 0;
  height = Math.abs(height);

  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new Error(`pt-loader: implausible BMP dimensions ${width}x${height}`);
  }
  assertPixelLimit(width, height, maxPixels, 'BMP');

  // ---- palette ----
  const paletteOffset = 14 + dibSize + (compression === BI_BITFIELDS && dibSize === 40 ? 12 : 0);
  let palette = null;
  if (bitCount <= 8) {
    const count = clrUsed || 1 << bitCount;
    if (!Number.isInteger(count) || count <= 0 || count > 256) {
      throw new Error(`pt-loader: implausible BMP palette size ${count}`);
    }
    if (paletteOffset < 0 || paletteOffset + count * paletteEntrySize > u8.length) {
      throw new Error('pt-loader: truncated BMP palette');
    }
    palette = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const o = paletteOffset + i * paletteEntrySize;
      if (o + 2 >= u8.length) break;
      palette[i * 4 + 0] = u8[o + 2]; // R
      palette[i * 4 + 1] = u8[o + 1]; // G
      palette[i * 4 + 2] = u8[o + 0]; // B
      palette[i * 4 + 3] = 255;
    }
  }

  // ---- channel masks ----
  let masks = null;
  if (compression === BI_BITFIELDS) {
    // V4/V5 keep the masks in the DIB header; INFOHEADER puts them right after.
    const mo = dibSize >= 52 ? 14 + 40 : 14 + dibSize;
    masks = {
      r: maskToShiftScale(dv.getUint32(mo + 0, true)),
      g: maskToShiftScale(dv.getUint32(mo + 4, true)),
      b: maskToShiftScale(dv.getUint32(mo + 8, true)),
      a: dibSize >= 56 ? maskToShiftScale(dv.getUint32(14 + 52, true)) : null,
    };
  } else if (bitCount === 16) {
    masks = {
      r: maskToShiftScale(0x7c00),
      g: maskToShiftScale(0x03e0),
      b: maskToShiftScale(0x001f),
      a: null,
    };
  }

  const out = new Uint8Array(width * height * 4);
  let hasAlpha = false;

  /** Write one RGBA pixel into the bottom-up output buffer. */
  const put = (x, row, r, g, b, a) => {
    if (x < 0 || x >= width || row < 0 || row >= height) return;
    const y = topDown ? height - 1 - row : row;
    const o = (y * width + x) * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
    if (a !== 255) hasAlpha = true;
  };

  if (compression === BI_RLE8 || compression === BI_RLE4) {
    decodeRLE(u8, dataOffset, width, height, compression, palette, put);
    return { width, height, data: out, hasAlpha };
  }

  const stride = (((bitCount * width + 31) / 32) | 0) * 4;

  for (let row = 0; row < height; row++) {
    const base = dataOffset + row * stride;
    if (base >= u8.length) break;

    for (let x = 0; x < width; x++) {
      switch (bitCount) {
        case 32: {
          const o = base + x * 4;
          if (masks) {
            const px = dv.getUint32(o, true);
            const r = ((px & masks.r.mask) >>> masks.r.shift) * masks.r.scale;
            const g = ((px & masks.g.mask) >>> masks.g.shift) * masks.g.scale;
            const b = ((px & masks.b.mask) >>> masks.b.shift) * masks.b.scale;
            const a = masks.a ? ((px & masks.a.mask) >>> masks.a.shift) * masks.a.scale : 255;
            put(x, row, r | 0, g | 0, b | 0, a | 0);
          } else {
            // BI_RGB 32bpp: the 4th byte is nominally unused. Treat it as alpha
            // only when at least one pixel is non-opaque, which is decided in a
            // second pass below.
            put(x, row, u8[o + 2], u8[o + 1], u8[o], u8[o + 3]);
          }
          break;
        }
        case 24: {
          const o = base + x * 3;
          put(x, row, u8[o + 2], u8[o + 1], u8[o], 255);
          break;
        }
        case 16: {
          const px = dv.getUint16(base + x * 2, true);
          const r = ((px & masks.r.mask) >>> masks.r.shift) * masks.r.scale;
          const g = ((px & masks.g.mask) >>> masks.g.shift) * masks.g.scale;
          const b = ((px & masks.b.mask) >>> masks.b.shift) * masks.b.scale;
          const a = masks.a ? ((px & masks.a.mask) >>> masks.a.shift) * masks.a.scale : 255;
          put(x, row, r | 0, g | 0, b | 0, a | 0);
          break;
        }
        case 8: {
          const i = u8[base + x] * 4;
          put(x, row, palette[i], palette[i + 1], palette[i + 2], 255);
          break;
        }
        case 4: {
          const byte = u8[base + (x >> 1)];
          const idx = ((x & 1) === 0 ? byte >> 4 : byte & 0x0f) * 4;
          put(x, row, palette[idx], palette[idx + 1], palette[idx + 2], 255);
          break;
        }
        case 1: {
          const byte = u8[base + (x >> 3)];
          const idx = ((byte >> (7 - (x & 7))) & 1) * 4;
          put(x, row, palette[idx], palette[idx + 1], palette[idx + 2], 255);
          break;
        }
        default:
          throw new Error(`pt-loader: unsupported BMP bit depth ${bitCount}`);
      }
    }
  }

  // A 32bpp BI_RGB bitmap whose 4th byte is always 0 has no alpha channel at
  // all — it is padding. Treat it as fully opaque instead of invisible.
  if (bitCount === 32 && !masks) {
    let anyNonZero = false;
    for (let i = 3; i < out.length; i += 4) {
      if (out[i] !== 0) {
        anyNonZero = true;
        break;
      }
    }
    if (!anyNonZero) {
      for (let i = 3; i < out.length; i += 4) out[i] = 255;
      hasAlpha = false;
    }
  }

  return { width, height, data: out, hasAlpha };
}

function assertPixelLimit(width, height, maxPixels, format) {
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new RangeError('pt-loader: maxPixels must be a positive integer');
  }
  if (width * height > maxPixels) {
    throw new RangeError(
      `pt-loader: ${format} dimensions ${width}x${height} exceed the ${maxPixels}-pixel limit`,
    );
  }
}

/** BI_RLE8 / BI_RLE4 decoder. */
function decodeRLE(u8, offset, width, height, compression, palette, put) {
  let p = offset;
  let x = 0;
  let row = 0;

  const emit = (paletteIndex) => {
    const i = paletteIndex * 4;
    put(x, row, palette[i], palette[i + 1], palette[i + 2], 255);
    x++;
  };

  while (p < u8.length - 1) {
    const count = u8[p++];
    const value = u8[p++];

    if (count > 0) {
      if (compression === BI_RLE8) {
        for (let i = 0; i < count; i++) emit(value);
      } else {
        for (let i = 0; i < count; i++) emit(i % 2 === 0 ? value >> 4 : value & 0x0f);
      }
      continue;
    }

    if (value === 0) {
      x = 0;
      row++;
      if (row >= height) return;
    } else if (value === 1) {
      return; // end of bitmap
    } else if (value === 2) {
      x += u8[p++];
      row += u8[p++];
      if (row >= height) return;
    } else {
      // absolute mode
      if (compression === BI_RLE8) {
        for (let i = 0; i < value; i++) emit(u8[p + i]);
        p += value + (value & 1); // pad to word boundary
      } else {
        for (let i = 0; i < value; i++) {
          const byte = u8[p + (i >> 1)];
          emit(i % 2 === 0 ? byte >> 4 : byte & 0x0f);
        }
        const bytes = (value + 1) >> 1;
        p += bytes + (bytes & 1);
      }
    }
  }
}
