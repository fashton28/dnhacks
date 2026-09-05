// Terrain: a heightfield around the Site. The Site sits on a flat plateau at z = 0; hills roll beyond it.
// Coordinates: ENU metres from the anchor (x east, y north). Three.js positions are (x, height, -y).
import * as THREE from "three";

export const TERRAIN_SIZE = 2400;
export const TERRAIN_SEGMENTS = 200;
export const PLATEAU_RADIUS = 230;   // flat out to here
export const PLATEAU_BLEND = 110;    // and blends into the hills over this distance

// ---- value noise -----------------------------------------------------------------------------
function hash(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function smooth(t: number): number { return t * t * (3 - 2 * t); }
export function valueNoise(x: number, y: number, seed = 0): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
/** fractal noise in [0, 1] */
export function fbm(x: number, y: number, octaves = 4, seed = 0): number {
  let v = 0, amp = 0.5, f = 1, sum = 0;
  for (let i = 0; i < octaves; i++) { v += amp * valueNoise(x * f, y * f, seed + i * 17); sum += amp; amp *= 0.5; f *= 2.1; }
  return v / sum;
}

export function terrainHeight(x: number, y: number): number {
  const r = Math.hypot(x, y);
  const t = THREE.MathUtils.smoothstep(r, PLATEAU_RADIUS, PLATEAU_RADIUS + PLATEAU_BLEND);
  if (t <= 0) return 0;
  const big = fbm(x / 520 + 3.1, y / 520 + 7.7, 3, 11) - 0.42;   // broad hills, slightly biased upward
  const mid = fbm(x / 160 + 1.3, y / 160 + 2.2, 3, 23) - 0.5;
  const fine = fbm(x / 45, y / 45, 2, 37) - 0.5;
  const h = big * 95 + mid * 22 + fine * 4;
  // gentle rise with distance so the horizon closes in like a valley
  const rise = THREE.MathUtils.smoothstep(r, 500, 1200) * 28;
  return t * Math.max(-6, h + rise);
}

export class Terrain {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  constructor(material: THREE.Material, woodMask: (x: number, y: number) => number) {
    const n = TERRAIN_SEGMENTS, size = TERRAIN_SIZE, d = size / n;
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    const uv = new Float32Array((n + 1) * (n + 1) * 2);
    const wood = new Float32Array((n + 1) * (n + 1));
    let k = 0;
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const x = -size / 2 + i * d, y = -size / 2 + j * d;
      pos[k * 3] = x; pos[k * 3 + 1] = terrainHeight(x, y); pos[k * 3 + 2] = -y;
      uv[k * 2] = i / n; uv[k * 2 + 1] = j / n;
      wood[k] = woodMask(x, y);
      k++;
    }
    const idx: number[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, dd = c + 1;
      idx.push(a, b, c, b, dd, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("aWood", new THREE.BufferAttribute(wood, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.receiveShadow = true;
    this.mesh.name = "ground";
  }
  heightAt(x: number, y: number): number { return terrainHeight(x, y); }
}
