/**
 * Priston Tale texture header obfuscation.
 *
 * The game does not encrypt image data — it corrupts only the file header:
 * the first two bytes are replaced with a marker, and every byte from index 2
 * onward has `i * i` added to it. BMP touches 14 bytes, TGA touches 18.
 *
 * The Java reference writes `buffer[i] -= (byte)(i*i)`. Replicating the byte
 * cast is unnecessary: subtraction modulo 256 gives the same result with or
 * without it, because `(byte)(i*i) === i*i (mod 256)`.
 */

/** Marker written over bytes 0..1 of an obfuscated BMP. */
export const BMP_ENCRYPTED_MAGIC = [0x41, 0x38];
/** Marker written over bytes 0..1 of an obfuscated TGA. */
export const TGA_ENCRYPTED_MAGIC = [0x47, 0x38];

/** Number of header bytes affected, per format. */
export const BMP_HEADER_BYTES = 14;
export const TGA_HEADER_BYTES = 18;

/** @param {Uint8Array} u8 */
export function isEncryptedBMP(u8) {
  return u8.length >= BMP_HEADER_BYTES && u8[0] === 0x41 && u8[1] === 0x38;
}

/** @param {Uint8Array} u8 */
export function isEncryptedTGA(u8) {
  return u8.length >= TGA_HEADER_BYTES && u8[0] === 0x47 && u8[1] === 0x38;
}

/** @param {Uint8Array} u8 */
export function isPlainBMP(u8) {
  return u8.length >= 2 && u8[0] === 0x42 && u8[1] === 0x4d; // "BM"
}

/**
 * Decrypt a BMP header in place.
 * @param {Uint8Array} u8 full file bytes
 * @returns {Uint8Array} the same array, for chaining
 */
export function decryptBMP(u8) {
  if (u8.length < BMP_HEADER_BYTES) {
    throw new Error(`pt-loader: BMP too short (${u8.length} bytes) to decrypt`);
  }
  u8[0] = 0x42;
  u8[1] = 0x4d;
  for (let i = 2; i < BMP_HEADER_BYTES; i++) u8[i] = (u8[i] - i * i) & 0xff;
  return u8;
}

/**
 * Decrypt a TGA header in place.
 * @param {Uint8Array} u8 full file bytes
 * @returns {Uint8Array} the same array, for chaining
 */
export function decryptTGA(u8) {
  if (u8.length < TGA_HEADER_BYTES) {
    throw new Error(`pt-loader: TGA too short (${u8.length} bytes) to decrypt`);
  }
  u8[0] = 0x00;
  u8[1] = 0x00;
  for (let i = 2; i < TGA_HEADER_BYTES; i++) u8[i] = (u8[i] - i * i) & 0xff;
  return u8;
}

/** Re-apply the BMP obfuscation (round-trips `decryptBMP`). */
export function encryptBMP(u8) {
  for (let i = BMP_HEADER_BYTES - 1; i >= 2; i--) u8[i] = (u8[i] + i * i) & 0xff;
  u8[0] = 0x41;
  u8[1] = 0x38;
  return u8;
}

/** Re-apply the TGA obfuscation (round-trips `decryptTGA`). */
export function encryptTGA(u8) {
  for (let i = TGA_HEADER_BYTES - 1; i >= 2; i--) u8[i] = (u8[i] + i * i) & 0xff;
  u8[0] = 0x47;
  u8[1] = 0x38;
  return u8;
}

/**
 * Detect the format and decrypt in place if needed.
 *
 * Detection is driven by the filename extension when available, because a
 * decrypted TGA legitimately starts with `00 00` and cannot be distinguished
 * from an arbitrary buffer by magic alone.
 *
 * @param {Uint8Array} u8 full file bytes, mutated in place
 * @param {string} [filename] used to pick the format; extension is enough
 * @returns {'bmp'|'tga'} the detected format
 */
export function decryptImage(u8, filename = '') {
  const ext = filename.toLowerCase().split('.').pop();

  if (isEncryptedBMP(u8)) {
    decryptBMP(u8);
    return 'bmp';
  }
  if (isEncryptedTGA(u8)) {
    decryptTGA(u8);
    return 'tga';
  }
  if (isPlainBMP(u8)) return 'bmp';
  if (ext === 'bmp') return 'bmp';
  if (ext === 'tga') return 'tga';

  throw new Error(
    `pt-loader: cannot determine image format for "${filename}" ` +
      `(first bytes: ${u8[0]?.toString(16)} ${u8[1]?.toString(16)})`,
  );
}
