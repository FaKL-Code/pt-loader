/**
 * Sequential little-endian reader for Priston Tale binary assets.
 *
 * Every structure in the SMD/SMB/INX family is a raw `fwrite` of a packed
 * Visual C++ struct: little-endian, no padding, no alignment. That means every
 * struct has a known fixed size and you can assert the cursor after reading it.
 * `expect()` exists for exactly that — use it liberally, because a 4-byte drift
 * only becomes visible thousands of bytes later.
 */
export class BinaryReader {
  /**
   * @param {ArrayBuffer|Uint8Array|DataView} source
   * @param {number} [offset] starting cursor position, in bytes
   */
  constructor(source, offset = 0) {
    if (source instanceof Uint8Array) {
      this.u8 = source;
      this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    } else if (source instanceof DataView) {
      this.u8 = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      this.view = source;
    } else if (source instanceof ArrayBuffer) {
      this.u8 = new Uint8Array(source);
      this.view = new DataView(source);
    } else {
      throw new TypeError('BinaryReader: expected ArrayBuffer, Uint8Array or DataView');
    }
    this.p = offset;
  }

  /** Total readable length in bytes. */
  get length() {
    return this.u8.byteLength;
  }

  /** Bytes left between the cursor and the end. */
  get remaining() {
    return this.u8.byteLength - this.p;
  }

  /** Current cursor position. */
  get offset() {
    return this.p;
  }

  set offset(v) {
    this.#bounds(v, 0);
    this.p = v;
  }

  #bounds(at, size) {
    if (at < 0 || at + size > this.u8.byteLength) {
      throw new RangeError(
        `BinaryReader: read of ${size} byte(s) at offset ${at} exceeds buffer of ${this.u8.byteLength} bytes`,
      );
    }
  }

  /** Signed 8-bit. */
  i8() {
    this.#bounds(this.p, 1);
    return this.view.getInt8(this.p++);
  }

  /** Unsigned 8-bit. */
  byte() {
    this.#bounds(this.p, 1);
    return this.u8[this.p++];
  }

  /** Signed 16-bit little-endian. */
  i16() {
    this.#bounds(this.p, 2);
    const v = this.view.getInt16(this.p, true);
    this.p += 2;
    return v;
  }

  /** Unsigned 16-bit little-endian. */
  u16() {
    this.#bounds(this.p, 2);
    const v = this.view.getUint16(this.p, true);
    this.p += 2;
    return v;
  }

  /** Signed 32-bit little-endian. */
  i32() {
    this.#bounds(this.p, 4);
    const v = this.view.getInt32(this.p, true);
    this.p += 4;
    return v;
  }

  /**
   * Unsigned 32-bit little-endian.
   *
   * Used for the serialized pointers. Pointer arithmetic must use the *same*
   * signedness on both operands — see `formats/relink.js`.
   */
  u32() {
    this.#bounds(this.p, 4);
    const v = this.view.getUint32(this.p, true);
    this.p += 4;
    return v;
  }

  /** 32-bit IEEE-754 little-endian. */
  f32() {
    this.#bounds(this.p, 4);
    const v = this.view.getFloat32(this.p, true);
    this.p += 4;
    return v;
  }

  /** Advance the cursor without reading. */
  skip(n) {
    this.#bounds(this.p, n);
    this.p += n;
    return this;
  }

  /** Read `n` raw bytes as a view onto the same memory (no copy). */
  bytes(n) {
    this.#bounds(this.p, n);
    const v = this.u8.subarray(this.p, this.p + n);
    this.p += n;
    return v;
  }

  /** Read `n` signed 32-bit integers. */
  i32Array(n) {
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.i32();
    return out;
  }

  /** Read `n` 32-bit floats. */
  f32Array(n) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.f32();
    return out;
  }

  /**
   * Fixed-width string field: reads Latin-1 bytes up to the first NUL and then
   * skips whatever remains of the field.
   *
   * This mirrors `Flyweight.getString(in, size)` in the Java reference. Reading
   * only up to the NUL without consuming the padding misaligns every subsequent
   * structure, which is the single most common porting bug in this format.
   */
  str(size) {
    this.#bounds(this.p, size);
    let s = '';
    for (let i = 0; i < size; i++) {
      const c = this.u8[this.p + i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    this.p += size;
    return s.trim();
  }

  /** NUL-terminated string of unbounded length (texture name block). */
  cstr() {
    let s = '';
    for (;;) {
      this.#bounds(this.p, 1);
      const c = this.u8[this.p++];
      if (c === 0) return s.trim();
      s += String.fromCharCode(c);
    }
  }

  /**
   * Assert the cursor sits exactly where a fixed-size structure should end.
   * @param {number} expected absolute byte offset
   * @param {string} what name used in the error message
   */
  expect(expected, what) {
    if (this.p !== expected) {
      throw new Error(
        `pt-loader: ${what} ended at offset ${this.p}, expected ${expected} ` +
          `(drift of ${this.p - expected} bytes). The stream is misaligned.`,
      );
    }
    return this;
  }
}

/**
 * Guard against absurd array sizes from a misaligned stream before allocating.
 * @param {Record<string, number>} counts
 * @param {number} [max]
 */
export function assertSaneCounts(counts, max = 1_000_000) {
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new Error(
        `pt-loader: implausible count ${name}=${value}. ` +
          `The stream is misaligned or the file is corrupt.`,
      );
    }
  }
}
