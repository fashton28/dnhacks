import { describe, expect, it } from 'vitest';

import { base64Encode, encodePngStored } from '../src/png.js';
import { decodePng, encodePng } from '../src/node/png.js';

function randomRgba(w: number, h: number, seed = 1234): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s & 0xff;
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  return out;
}

describe('png codec', () => {
  it('roundtrips RGBA through the deflate encoder + decoder', () => {
    const w = 61;
    const h = 47;
    const rgba = randomRgba(w, h);
    const decoded = decodePng(encodePng(rgba, w, h));
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(Buffer.compare(Buffer.from(decoded.rgba), Buffer.from(rgba))).toBe(0);
  });

  it('roundtrips RGBA through the browser-safe stored encoder + decoder', () => {
    const w = 40;
    const h = 40;
    const rgba = randomRgba(w, h, 99);
    const decoded = decodePng(encodePngStored(rgba, w, h));
    expect(decoded.width).toBe(w);
    expect(decoded.height).toBe(h);
    expect(Buffer.compare(Buffer.from(decoded.rgba), Buffer.from(rgba))).toBe(0);
  });

  it('handles images larger than one stored zlib block (>64 KiB raw)', () => {
    const w = 160;
    const h = 120; // raw scanlines = (160*4+1)*120 ~ 77 KB -> 2 stored blocks
    const rgba = randomRgba(w, h, 7);
    const decoded = decodePng(encodePngStored(rgba, w, h));
    expect(Buffer.compare(Buffer.from(decoded.rgba), Buffer.from(rgba))).toBe(0);
  });

  it('base64 matches Node Buffer base64', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33]) {
      const bytes = randomRgba(1, 1, len).subarray(0, len);
      expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('rejects non-PNG bytes', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a PNG/);
  });
});
