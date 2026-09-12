/**
 * Truevision TGA decoder.
 *
 * Output is **bottom-up RGBA** (row 0 = bottom of image), matching `decodeBMP`
 * and OpenGL's texture layout. The TGA origin bit is honoured, so images
 * flagged top-down are flipped during decode.
 *
 * Supported image types: 1 (colour-mapped), 2 (true colour), 3 (greyscale) and
 * their RLE counterparts 9, 10 and 11. Pixel depths: 8, 15, 16, 24 and 32.
 */

/**
 * @param {Uint8Array} u8 full, already-decrypted TGA file
 * @returns {{width:number, height:number, data:Uint8Array, hasAlpha:boolean}}
 */
export function decodeTGA(u8) {
  if (u8.length < 18) throw new Error('pt-loader: TGA shorter than its 18-byte header');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const idLength = u8[0];
  const colorMapType = u8[1];
  const imageType = u8[2];
  const cmFirstIndex = dv.getUint16(3, true);
  const cmLength = dv.getUint16(5, true);
  const cmEntrySize = u8[7];
  const width = dv.getUint16(12, true);
  const height = dv.getUint16(14, true);
  const pixelDepth = u8[16];
  const descriptor = u8[17];

  const rightToLeft = (descriptor & 0x10) !== 0;
  const topToBottom = (descriptor & 0x20) !== 0;

  if (width <= 0 || height <= 0 || width > 16384 || height > 16384) {
    throw new Error(`pt-loader: implausible TGA dimensions ${width}x${height}`);
  }

  const rle = imageType >= 9 && imageType <= 11;
  const baseType = rle ? imageType - 8 : imageType;
  if (baseType !== 1 && baseType !== 2 && baseType !== 3) {
    throw new Error(`pt-loader: unsupported TGA image type ${imageType}`);
  }

  let p = 18 + idLength;

  // ---- colour map ----
  let cmap = null;
  if (colorMapType === 1 && cmLength > 0) {
    const entryBytes = Math.ceil(cmEntrySize / 8);
    cmap = new Uint8Array((cmFirstIndex + cmLength) * 4);
    for (let i = 0; i < cmLength; i++) {
      const o = p + i * entryBytes;
      const t = (cmFirstIndex + i) * 4;
      readPixel(u8, dv, o, cmEntrySize, cmap, t);
    }
    p += cmLength * entryBytes;
  }

  const bytesPerPixel = Math.ceil(pixelDepth / 8);
  const pixelCount = width * height;
  const raw = new Uint8Array(pixelCount * 4);

  if (!rle) {
    for (let i = 0; i < pixelCount; i++) {
      const o = p + i * bytesPerPixel;
      if (o + bytesPerPixel > u8.length) break;
      if (baseType === 1) {
        const idx = (pixelDepth === 16 ? dv.getUint16(o, true) : u8[o]) * 4;
        raw[i * 4] = cmap[idx];
        raw[i * 4 + 1] = cmap[idx + 1];
        raw[i * 4 + 2] = cmap[idx + 2];
        raw[i * 4 + 3] = cmap[idx + 3];
      } else {
        readPixel(u8, dv, o, pixelDepth, raw, i * 4, baseType === 3);
      }
    }
  } else {
    let i = 0;
    while (i < pixelCount && p < u8.length) {
      const packet = u8[p++];
      const count = (packet & 0x7f) + 1;

      if (packet & 0x80) {
        // run-length packet: one pixel repeated
        const tmp = new Uint8Array(4);
        if (baseType === 1) {
          const idx = (pixelDepth === 16 ? dv.getUint16(p, true) : u8[p]) * 4;
          tmp.set(cmap.subarray(idx, idx + 4));
        } else {
          readPixel(u8, dv, p, pixelDepth, tmp, 0, baseType === 3);
        }
        p += bytesPerPixel;
        for (let k = 0; k < count && i < pixelCount; k++, i++) raw.set(tmp, i * 4);
      } else {
        // raw packet: `count` literal pixels
        for (let k = 0; k < count && i < pixelCount; k++, i++) {
          if (baseType === 1) {
            const idx = (pixelDepth === 16 ? dv.getUint16(p, true) : u8[p]) * 4;
            raw[i * 4] = cmap[idx];
            raw[i * 4 + 1] = cmap[idx + 1];
            raw[i * 4 + 2] = cmap[idx + 2];
            raw[i * 4 + 3] = cmap[idx + 3];
          } else {
            readPixel(u8, dv, p, pixelDepth, raw, i * 4, baseType === 3);
          }
          p += bytesPerPixel;
        }
      }
    }
  }

  // ---- orient to bottom-up, left-to-right ----
  let data = raw;
  if (topToBottom || rightToLeft) {
    data = new Uint8Array(pixelCount * 4);
    for (let row = 0; row < height; row++) {
      // `row` indexes the decoded buffer in storage order.
      const y = topToBottom ? height - 1 - row : row;
      for (let x = 0; x < width; x++) {
        const sx = rightToLeft ? width - 1 - x : x;
        const src = (row * width + sx) * 4;
        const dst = (y * width + x) * 4;
        data[dst] = raw[src];
        data[dst + 1] = raw[src + 1];
        data[dst + 2] = raw[src + 2];
        data[dst + 3] = raw[src + 3];
      }
    }
  }

  let hasAlpha = false;
  if (pixelDepth === 32 || pixelDepth === 16 || pixelDepth === 15) {
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 255) {
        hasAlpha = true;
        break;
      }
    }
    // A 32-bit TGA with an all-zero alpha channel is opaque padding, not an
    // invisible image.
    if (hasAlpha) {
      let anyNonZero = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 0) {
          anyNonZero = true;
          break;
        }
      }
      if (!anyNonZero) {
        for (let i = 3; i < data.length; i += 4) data[i] = 255;
        hasAlpha = false;
      }
    }
  }

  return { width, height, data, hasAlpha };
}

/** Decode one source pixel into RGBA at `out[at]`. */
function readPixel(u8, dv, o, depth, out, at, greyscale = false) {
  switch (depth) {
    case 32:
      out[at] = u8[o + 2];
      out[at + 1] = u8[o + 1];
      out[at + 2] = u8[o];
      out[at + 3] = u8[o + 3];
      return;
    case 24:
      out[at] = u8[o + 2];
      out[at + 1] = u8[o + 1];
      out[at + 2] = u8[o];
      out[at + 3] = 255;
      return;
    case 16:
    case 15: {
      const px = dv.getUint16(o, true);
      // A1R5G5B5
      out[at] = (((px >> 10) & 0x1f) * 255) / 31;
      out[at + 1] = (((px >> 5) & 0x1f) * 255) / 31;
      out[at + 2] = ((px & 0x1f) * 255) / 31;
      out[at + 3] = depth === 16 && (px & 0x8000) === 0 ? 0 : 255;
      return;
    }
    case 8: {
      const v = u8[o];
      if (greyscale) {
        out[at] = v;
        out[at + 1] = v;
        out[at + 2] = v;
        out[at + 3] = 255;
      } else {
        out[at] = v;
        out[at + 1] = v;
        out[at + 2] = v;
        out[at + 3] = 255;
      }
      return;
    }
    default:
      throw new Error(`pt-loader: unsupported TGA pixel depth ${depth}`);
  }
}
