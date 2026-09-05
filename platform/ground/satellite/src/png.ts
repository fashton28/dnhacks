/* ============================================================================
 * eis-satellite — dependency-free PNG ENCODER (pure TS, Node + browser).
 *
 * Emits a valid 8-bit RGBA PNG using an UNCOMPRESSED zlib stream (deflate
 * "stored" blocks, BTYPE=00). Larger than deflate output but requires no
 * zlib/canvas/Buffer, so the detection core can mint thumbnail data URLs in
 * any environment. Any standards-compliant decoder (browsers, node:zlib
 * inflate, pngjs) reads these files.
 *
 * The Node-side helper (src/node/png.ts) has a real-deflate encoder and a
 * decoder; PNG DECODE is deliberately kept OUT of this browser-safe module —
 * browsers decode via Image/canvas (see README).
 * ========================================================================== */

/* ---- CRC32 (PNG chunk checksums) ---------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ---- adler32 (zlib stream checksum) ------------------------------------- */

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/* ---- zlib stream with stored (uncompressed) deflate blocks --------------- */

function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  let p = 0;
  out[p++] = 0x78; // CMF: deflate, 32K window
  out[p++] = 0x01; // FLG: no dict, fastest (FCHECK makes (CMF*256+FLG) % 31 == 0)
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const chunk = raw.subarray(start, Math.min(start + 65535, raw.length));
    out[p++] = i === blocks - 1 ? 1 : 0; // BFINAL + BTYPE=00
    out[p++] = chunk.length & 0xff;
    out[p++] = (chunk.length >>> 8) & 0xff;
    out[p++] = ~chunk.length & 0xff;
    out[p++] = (~chunk.length >>> 8) & 0xff;
    out.set(chunk, p);
    p += chunk.length;
  }
  const ad = adler32(raw);
  out[p++] = (ad >>> 24) & 0xff;
  out[p++] = (ad >>> 16) & 0xff;
  out[p++] = (ad >>> 8) & 0xff;
  out[p++] = ad & 0xff;
  return out.subarray(0, p);
}

/* ---- PNG assembly -------------------------------------------------------- */

const PNG_SIG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Serialize scanlines: filter byte 0 (None) + raw RGBA per row. */
export function rgbaToScanlines(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgbaToScanlines: expected ${width * height * 4} bytes, got ${rgba.length}`);
  }
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return raw;
}

/** Encode 8-bit RGBA into a valid PNG (uncompressed zlib). Browser-safe. */
export function encodePngStored(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  const idat = zlibStored(rgbaToScanlines(rgba, width, height));
  const parts = [PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

/* ---- base64 / data URLs (no btoa, no Buffer) ----------------------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >>> 18) & 63] + B64[(n >>> 12) & 63] + B64[(n >>> 6) & 63] + '=';
  }
  return out;
}

/** Encode RGBA to a `data:image/png;base64,...` URL. Browser-safe. */
export function rgbaToPngDataUrl(rgba: Uint8Array, width: number, height: number): string {
  return `data:image/png;base64,${base64Encode(encodePngStored(rgba, width, height))}`;
}
