/* ============================================================================
 * eis-satellite — Node-only PNG codec (node:zlib; no external deps).
 *
 * encodePng: real-deflate PNG (small files; used by the tile generator).
 * decodePng: decodes 8-bit greyscale/RGB/RGBA non-interlaced PNGs (all five
 * scanline filters) to RGBA. That covers everything this package writes plus
 * ordinary un-paletted tiles. Browsers do NOT use this module — the UI
 * decodes via Image/canvas (see README).
 * ========================================================================== */

import { deflateSync, inflateSync } from 'node:zlib';
import { crc32, rgbaToScanlines } from '../png.js';

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

/** Encode 8-bit RGBA to a deflate-compressed PNG (Node only). */
export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const idat = new Uint8Array(deflateSync(rgbaToScanlines(rgba, width, height), { level: 9 }));
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

export interface DecodedPng {
  width: number;
  height: number;
  /** Always RGBA (grey/RGB inputs are expanded, alpha = 255). */
  rgba: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode an 8-bit non-interlaced grey/RGB/RGBA PNG to RGBA (Node only). */
export function decodePng(bytes: Uint8Array): DecodedPng {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('decodePng: not a PNG (bad signature)');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idats: Uint8Array[] = [];

  let p = 8;
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      bitDepth = bytes[p + 16];
      colorType = bytes[p + 17];
      const interlace = bytes[p + 20];
      if (bitDepth !== 8) throw new Error(`decodePng: unsupported bit depth ${bitDepth}`);
      if (colorType !== 0 && colorType !== 2 && colorType !== 6) {
        throw new Error(`decodePng: unsupported color type ${colorType} (grey/RGB/RGBA only)`);
      }
      if (interlace !== 0) throw new Error('decodePng: interlaced PNGs are unsupported');
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len; // len + type + data + crc
  }
  if (!width || !height || colorType < 0) throw new Error('decodePng: missing IHDR');
  if (idats.length === 0) throw new Error('decodePng: no IDAT data');

  const compressed = new Uint8Array(idats.reduce((n, d) => n + d.length, 0));
  let cp = 0;
  for (const d of idats) {
    compressed.set(d, cp);
    cp += d.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) {
    throw new Error(`decodePng: bad inflated length ${raw.length}, expected ${(stride + 1) * height}`);
  }

  // Unfilter in place into `pix` (per PNG spec, filters operate per byte).
  const pix = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pix.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pix.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;        // left
      const b = prev ? prev[x] : 0;                            // up
      const c = prev && x >= channels ? prev[x - channels] : 0; // up-left
      let v = row[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`decodePng: unknown filter type ${filter} on row ${y}`);
      }
      out[x] = v;
    }
  }

  if (channels === 4) return { width, height, rgba: pix };

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (channels === 3) {
      rgba[i * 4] = pix[i * 3];
      rgba[i * 4 + 1] = pix[i * 3 + 1];
      rgba[i * 4 + 2] = pix[i * 3 + 2];
    } else {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = pix[i];
    }
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}
