import { decryptImage } from '../io/crypto.js';
import { decodeBMP } from './bmp.js';
import { decodeTGA } from './tga.js';

/**
 * Decrypt (if needed) and decode a Priston Tale texture into raw RGBA.
 *
 * The returned `data` is **bottom-up**: row 0 is the bottom row of the image.
 * This is the OpenGL texture layout, so the caller creates the texture with
 * `flipY = false` and keeps the `1 - v` flip on the UV attribute.
 *
 * `PNG`, `JPEG` and `WEBP` inputs are rejected here — those are handled by the
 * browser's own decoder in `TextureCache`, which is faster and supports more
 * variants than anything worth hand-writing.
 *
 * @param {ArrayBuffer|Uint8Array} buffer file bytes; mutated in place when encrypted
 * @param {string} [filename] used to disambiguate BMP from TGA
 * @param {{maxPixels?: number}} [options]
 * @returns {{width:number, height:number, data:Uint8Array, hasAlpha:boolean, format:'bmp'|'tga'}}
 */
export function decodeImage(buffer, filename = '', { maxPixels = 16 * 1024 * 1024 } = {}) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const format = decryptImage(u8, filename);
  const decoded = format === 'bmp' ? decodeBMP(u8, { maxPixels }) : decodeTGA(u8, { maxPixels });
  return { ...decoded, format };
}

/** File extensions this module can decode without the browser. */
export const RAW_EXTENSIONS = new Set(['bmp', 'tga']);

/** File extensions best handled by `createImageBitmap`. */
export const NATIVE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif']);
