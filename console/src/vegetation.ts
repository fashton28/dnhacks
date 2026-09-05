// Woodland: procedural low-poly trees, instanced by species, placed on the terrain.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { fbm } from "./terrain";

export type TreePlacement = { x: number; y: number; z: number; scale: number; rot: number; species: number; tint: THREE.Color };

function colored(src: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const geo = src.index ? src.toNonIndexed() : src;  // merge needs all parts indexed or none; icospheres are non-indexed
  const n = geo.getAttribute("position").count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return geo;
}
function jitter(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = geo.getAttribute("position") as THREE.BufferAttribute;
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) + rnd() * amount, p.getY(i) + rnd() * amount * 0.5, p.getZ(i) + rnd() * amount);
  geo.computeVertexNormals();
  return geo;
}

const TRUNK = new THREE.Color(0x4b3826);

/** Pine: trunk plus four stacked, jittered cones. About 200 triangles. */
export function pineGeometry(seed = 1): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(colored(new THREE.CylinderGeometry(0.22, 0.38, 4.2, 6).translate(0, 2.1, 0), TRUNK));
  const green = new THREE.Color(0x3c6b31);
  const tiers = [[3.3, 5.5, 4.2], [2.6, 4.8, 7.4], [1.9, 4.0, 10.2], [1.1, 3.2, 12.6]];
  tiers.forEach(([r, h, y], i) => parts.push(colored(jitter(new THREE.ConeGeometry(r, h, 9, 1).translate(0, y, 0), 0.35, seed + i), green.clone().offsetHSL(0, 0, (i - 1.5) * 0.02))));
  return mergeGeometries(parts, false)!;
}

/** Deciduous: trunk plus a cluster of low-poly spheres. About 200 triangles. */
export function deciduousGeometry(seed = 2): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(colored(new THREE.CylinderGeometry(0.25, 0.42, 3.6, 6).translate(0, 1.8, 0), TRUNK));
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const green = new THREE.Color(0x3f6a2a);
  for (let i = 0; i < 6; i++) {
    const r = 1.6 + rnd() * 1.2;
    const g = new THREE.IcosahedronGeometry(r, 1).translate((rnd() - 0.5) * 2.4, 4.4 + rnd() * 2.2, (rnd() - 0.5) * 2.4);
    parts.push(colored(jitter(g, 0.3, seed + i), green.clone().offsetHSL((rnd() - 0.5) * 0.03, 0, (rnd() - 0.5) * 0.08)));
  }
  return mergeGeometries(parts, false)!;
}

/** Shrub-like young pine for undergrowth variety. */
export function saplingGeometry(seed = 3): THREE.BufferGeometry {
  const parts = [colored(new THREE.CylinderGeometry(0.1, 0.16, 1.4, 5).translate(0, 0.7, 0), TRUNK)];
  const green = new THREE.Color(0x527d38);
  parts.push(colored(jitter(new THREE.ConeGeometry(1.6, 3.2, 7, 1).translate(0, 2.4, 0), 0.25, seed), green));
  parts.push(colored(jitter(new THREE.ConeGeometry(1.0, 2.4, 7, 1).translate(0, 4.0, 0), 0.2, seed + 1), green.clone().offsetHSL(0, 0, 0.03)));
  return mergeGeometries(parts, false)!;
}

export type WoodlandOptions = {
  size: number;                 // terrain size (metres)
  exclusionHalf: number;        // no trees inside this square half-width
  bands: number[][];            // [x0, y0, x1, y1] dense bands from site.json
  bandDensity: number;          // trees per m² inside bands
  hillDensity: number;          // base trees per m² on the hills, modulated by noise
  heightAt: (x: number, y: number) => number;
  seed: number;
  densityScale: number;
};

/** Forest cover in [0, 1] at a point: dense in the bands, patchy woods on the hills, none near the Site. */
export function forestCover(x: number, y: number, o: WoodlandOptions): number {
  if (Math.max(Math.abs(x), Math.abs(y)) < o.exclusionHalf) return 0;
  let cover = 0;
  for (const [x0, y0, x1, y1] of o.bands) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) cover = 1;
  const r = Math.hypot(x, y);
  const n = fbm(x / 210 + 5, y / 210 + 9, 3, 51);
  const hills = THREE.MathUtils.smoothstep(r, 250, 420) * THREE.MathUtils.smoothstep(n, 0.42, 0.62);
  // fewer trees on the higher, exposed tops
  const h = o.heightAt(x, y);
  const alpine = 1 - THREE.MathUtils.smoothstep(h, 45, 70);
  return Math.max(cover, hills * alpine);
}

export function placeTrees(o: WoodlandOptions): TreePlacement[] {
  let s = o.seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out: TreePlacement[] = [];
  const cell = 6;  // metres
  const half = o.size / 2;
  for (let y = -half; y < half; y += cell) for (let x = -half; x < half; x += cell) {
    const cx = x + rnd() * cell, cy = y + rnd() * cell;
    const cover = forestCover(cx, cy, o);
    if (cover <= 0) continue;
    const inBand = o.bands.some(([x0, y0, x1, y1]) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1);
    const density = (inBand ? o.bandDensity : o.hillDensity * cover) * o.densityScale;
    if (rnd() > density * cell * cell) continue;
    const speciesNoise = fbm(cx / 90, cy / 90, 2, 71);
    const species = rnd() < 0.12 ? 2 : speciesNoise > 0.55 ? 1 : 0;
    const tint = new THREE.Color().setHSL(0.26 + (rnd() - 0.5) * 0.05, 0.28 + rnd() * 0.16, 0.36 + (rnd() - 0.5) * 0.12);
    out.push({ x: cx, y: cy, z: o.heightAt(cx, cy), scale: (species === 2 ? 0.8 : 0.75) + rnd() * 0.7, rot: rnd() * Math.PI * 2, species, tint });
  }
  return out;
}

export function buildWoodland(placements: TreePlacement[], shadowsNear: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "woodland";
  const geos = [pineGeometry(), deciduousGeometry(), saplingGeometry()];
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  // split each species into a near set (casts shadows) and a far set (cheap)
  for (let sp = 0; sp < geos.length; sp++) {
    for (const near of [true, false]) {
      const items = placements.filter((p) => p.species === sp && (Math.hypot(p.x, p.y) < shadowsNear) === near);
      if (!items.length) continue;
      const mesh = new THREE.InstancedMesh(geos[sp], mat, items.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
      items.forEach((p, i) => {
        q.setFromAxisAngle(up, p.rot);
        m4.compose(new THREE.Vector3(p.x, p.z - 0.2, -p.y), q, new THREE.Vector3(p.scale, p.scale, p.scale));
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, p.tint);
      });
      mesh.castShadow = near;
      mesh.receiveShadow = near;
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }
  return group;
}
