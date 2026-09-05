// Site details: cooling pond, steam plumes, window facades, roof plant, light poles, parking lot with cars.
import * as THREE from "three";

export const enuToThree = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);

// ---- facades ---------------------------------------------------------------------------------
/** A wall texture with a window grid: rows of glazing on a concrete or cladding base. Also usable as emissive map. */
export function facadeTexture(widthM: number, heightM: number, opts: { base: string; frame: string; glass: string; rows: number; colsPerM: number; sill?: boolean }): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const px = 64;  // pixels per metre
  const c = document.createElement("canvas"); c.width = Math.min(4096, Math.round(widthM * px)); c.height = Math.min(2048, Math.round(heightM * px));
  const e = document.createElement("canvas"); e.width = c.width; e.height = c.height;
  const ctx = c.getContext("2d")!, ectx = e.getContext("2d")!;
  ctx.fillStyle = opts.base; ctx.fillRect(0, 0, c.width, c.height);
  ectx.fillStyle = "#000"; ectx.fillRect(0, 0, e.width, e.height);
  // subtle panel seams
  ctx.strokeStyle = "rgba(0,0,0,0.12)"; ctx.lineWidth = 2;
  for (let x = 0; x < c.width; x += px * 3) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.height); ctx.stroke(); }
  const cols = Math.max(1, Math.round(widthM * opts.colsPerM));
  const cw = c.width / cols, rh = c.height / opts.rows;
  for (let r = 0; r < opts.rows; r++) for (let k = 0; k < cols; k++) {
    const x = k * cw + cw * 0.22, y = r * rh + rh * 0.28, w = cw * 0.56, h = rh * 0.44;
    ctx.fillStyle = opts.frame; ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
    ctx.fillStyle = opts.glass; ctx.fillRect(x, y, w, h);
    const g = ctx.createLinearGradient(x, y, x + w, y + h); g.addColorStop(0, "rgba(255,255,255,0.25)"); g.addColorStop(1, "rgba(255,255,255,0.0)");
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    if (opts.sill) { ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(x - 4, y + h + 3, w + 8, 4); }
    // some rooms lit
    const lit = ((r * 7 + k * 13) % 5) === 0;
    ectx.fillStyle = lit ? "#5a4a2a" : "#0a0c12"; ectx.fillRect(x, y, w, h);
  }
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
  const emissive = new THREE.CanvasTexture(e); emissive.colorSpace = THREE.SRGBColorSpace;
  return { map, emissive };
}

export function facadeMaterial(widthM: number, heightM: number, style: "office" | "industrial"): THREE.MeshStandardMaterial {
  const o = style === "office"
    ? { base: "#b9b4a8", frame: "#3a3d42", glass: "#1e3140", rows: Math.max(1, Math.round(heightM / 3.2)), colsPerM: 0.55, sill: true }
    : { base: "#8f979f", frame: "#2b2f34", glass: "#26343d", rows: 1, colsPerM: 0.18, sill: false };
  const { map, emissive } = facadeTexture(widthM, heightM, o);
  return new THREE.MeshStandardMaterial({ map, emissiveMap: emissive, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.35, roughness: style === "office" ? 0.75 : 0.55, metalness: style === "office" ? 0.05 : 0.45 });
}

// ---- roof plant -------------------------------------------------------------------------------
const hvac = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.6, metalness: 0.5 });
const dark = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.7, metalness: 0.4 });
const pipe = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.45, metalness: 0.7 });
const pipeAccent = new THREE.MeshStandardMaterial({ color: 0x8b2a2a, roughness: 0.5, metalness: 0.3 });

export function roofPlant(x: number, y: number, size: [number, number, number], seed: number): THREE.Group {
  const g = new THREE.Group();
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const n = Math.max(2, Math.round((size[0] * size[1]) / 180));
  for (let i = 0; i < n; i++) {
    const w = 1.8 + rnd() * 2.2, d = 1.4 + rnd() * 1.8, h = 1.0 + rnd() * 1.2;
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), rnd() > 0.5 ? hvac : dark);
    box.position.set(x + (rnd() - 0.5) * (size[0] - 6), size[2] + h / 2, -(y + (rnd() - 0.5) * (size[1] - 6)));
    box.castShadow = true;
    g.add(box);
    if (rnd() > 0.6) {
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.3, 14), dark);
      fan.position.set(box.position.x, size[2] + h + 0.15, box.position.z);
      g.add(fan);
    }
  }
  // parapet
  const par = new THREE.Mesh(new THREE.BoxGeometry(size[0] + 0.3, 0.5, size[1] + 0.3), dark);
  par.position.set(x, size[2] + 0.15, -y);
  g.add(par);
  return g;
}

export function stack(x: number, y: number, h: number, r: number): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.8, r, h, 20), pipe);
  body.position.set(x, h / 2, -y); body.castShadow = true; g.add(body);
  for (let k = 1; k <= 3; k++) { const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 0.95, 0.08, 6, 20), pipeAccent); ring.rotation.x = Math.PI / 2; ring.position.set(x, h * k / 3.2, -y); g.add(ring); }
  return g;
}

/** A pipe rack running between two points at a given height, with several parallel pipes. */
export function pipeRack(a: [number, number], b: [number, number], h: number, count = 3): THREE.Group {
  const g = new THREE.Group();
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy), ang = Math.atan2(dx, dy);
  for (let i = 0; i < count; i++) {
    const r = i === 1 ? 0.45 : 0.28;
    const p = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), i === 1 ? pipeAccent : pipe);
    p.rotation.x = Math.PI / 2; p.rotation.z = -ang;
    // offsets perpendicular to the run
    const off = (i - (count - 1) / 2) * 1.1;
    p.position.set((a[0] + b[0]) / 2 + Math.cos(ang) * off, h + 0.3 + (i === 1 ? 0.2 : 0), -((a[1] + b[1]) / 2) + Math.sin(ang) * off);
    p.castShadow = true;
    g.add(p);
  }
  const supports = Math.max(2, Math.floor(len / 12));
  for (let k = 0; k <= supports; k++) {
    const t = k / supports;
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, h, 0.3), dark);
    post.position.set(a[0] + dx * t, h / 2, -(a[1] + dy * t));
    const beam = new THREE.Mesh(new THREE.BoxGeometry(count * 1.1 + 0.6, 0.25, 0.3), dark);
    beam.rotation.y = -ang; beam.position.set(a[0] + dx * t, h, -(a[1] + dy * t));
    g.add(post, beam);
  }
  return g;
}

// ---- light poles ------------------------------------------------------------------------------
const poleMat = new THREE.MeshStandardMaterial({ color: 0x6c7076, roughness: 0.5, metalness: 0.7 });
const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xffe2a8, emissiveIntensity: 1.6, roughness: 0.3 });
export function lightPole(x: number, y: number, armDir: number): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 9, 8), poleMat); pole.position.set(0, 4.5, 0); pole.castShadow = true;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.8, 6), poleMat); arm.rotation.z = Math.PI / 2; arm.position.set(0.9 * Math.cos(armDir), 8.9, -0.9 * Math.sin(armDir)); arm.rotation.y = armDir;
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.18, 0.35), lampMat); lamp.position.set(1.7 * Math.cos(armDir), 8.85, -1.7 * Math.sin(armDir)); lamp.rotation.y = armDir;
  g.add(pole, arm, lamp);
  g.position.set(x, 0, -y);
  return g;
}

// ---- parking and cars -------------------------------------------------------------------------
const tyre = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.95 });
const glass = new THREE.MeshPhysicalMaterial({ color: 0x0d1a26, roughness: 0.1, metalness: 0.9 });
export function car(color: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.3, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.06 });
  const L = 4.3 + rnd() * 0.7, W = 1.8, suv = rnd() > 0.5;
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, suv ? 0.75 : 0.6, L), paint); body.position.y = suv ? 0.78 : 0.7; g.add(body);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, suv ? 0.7 : 0.55, L * (suv ? 0.62 : 0.5)), paint); cab.position.set(0, (suv ? 1.5 : 1.25), suv ? 0.15 : 0.1); g.add(cab);
  const win = new THREE.Mesh(new THREE.BoxGeometry(W * 0.94, suv ? 0.4 : 0.32, L * (suv ? 0.6 : 0.48)), glass); win.position.copy(cab.position); win.position.y += 0.05; g.add(win);
  for (const [dx, dz] of [[W / 2 - 0.1, L / 2 - 0.8], [-(W / 2 - 0.1), L / 2 - 0.8], [W / 2 - 0.1, -(L / 2 - 0.8)], [-(W / 2 - 0.1), -(L / 2 - 0.8)]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.25, 16), tyre); w.rotation.z = Math.PI / 2; w.position.set(dx, 0.36, dz); g.add(w);
  }
  g.traverse((m) => { (m as THREE.Mesh).castShadow = true; });
  return g;
}

const CAR_COLORS = [0xd9d9d9, 0x1f1f22, 0x8a8f96, 0x2b3f6b, 0x7a1a1a, 0xe8e8e8, 0x3c3c40, 0x6b7d3a];
export function parkingLot(x: number, y: number, w: number, d: number, asphalt: THREE.Material, seed: number): THREE.Group {
  const g = new THREE.Group();
  const lot = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, d), asphalt); lot.position.set(x, 0.025, -y); lot.receiveShadow = true; g.add(lot);
  const paint = new THREE.MeshStandardMaterial({ color: 0xe6e2d6, roughness: 0.9 });
  let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const bays = Math.floor(w / 2.8);
  for (let i = 0; i <= bays; i++) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.01, 5.2), paint); line.position.set(x - w / 2 + i * 2.8, 0.056, -(y + d / 2 - 2.8)); g.add(line);
    if (i < bays && rnd() > 0.45) {
      const c = car(CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)], seed + i);
      c.position.set(x - w / 2 + i * 2.8 + 1.4, 0.05, -(y + d / 2 - 2.8)); c.rotation.y = Math.PI + (rnd() - 0.5) * 0.06; g.add(c);
    }
  }
  return g;
}

// ---- cooling pond -----------------------------------------------------------------------------
export class Pond {
  mesh: THREE.Mesh;
  private normalMap: THREE.CanvasTexture;
  constructor(x: number, y: number, w: number, d: number) {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(256, 256);
    for (let i = 0; i < 256 * 256; i++) {
      const px = i % 256, py = Math.floor(i / 256);
      const nx = Math.sin(px * 0.21 + py * 0.07) * 0.5 + Math.sin(px * 0.05 - py * 0.13) * 0.5;
      const ny = Math.cos(py * 0.19 + px * 0.04) * 0.5 + Math.cos(px * 0.11 + py * 0.09) * 0.5;
      img.data[i * 4] = 128 + nx * 12; img.data[i * 4 + 1] = 128 + ny * 12; img.data[i * 4 + 2] = 255; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.normalMap = new THREE.CanvasTexture(c);
    this.normalMap.wrapS = this.normalMap.wrapT = THREE.RepeatWrapping;
    this.normalMap.repeat.set(w / 6, d / 6);
    const mat = new THREE.MeshPhysicalMaterial({ color: 0x1a3d44, roughness: 0.06, metalness: 0.0, normalMap: this.normalMap, normalScale: new THREE.Vector2(0.35, 0.35), transparent: true, opacity: 0.94, envMapIntensity: 1.2 });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(x, 0.12, -y);
    this.mesh.receiveShadow = true;
    this.mesh.name = "cooling_pond";
  }
  rim(concrete: THREE.Material): THREE.Mesh {
    const w = (this.mesh.geometry as THREE.PlaneGeometry).parameters.width + 2, d = (this.mesh.geometry as THREE.PlaneGeometry).parameters.height + 2;
    const shape = new THREE.Shape(); shape.moveTo(-w / 2, -d / 2); shape.lineTo(w / 2, -d / 2); shape.lineTo(w / 2, d / 2); shape.lineTo(-w / 2, d / 2); shape.closePath();
    const hole = new THREE.Path(); hole.moveTo(-w / 2 + 1, -d / 2 + 1); hole.lineTo(w / 2 - 1, -d / 2 + 1); hole.lineTo(w / 2 - 1, d / 2 - 1); hole.lineTo(-w / 2 + 1, d / 2 - 1); hole.closePath();
    shape.holes.push(hole);
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false }), concrete);
    m.rotation.x = -Math.PI / 2; m.position.set(this.mesh.position.x, 0, this.mesh.position.z); m.receiveShadow = true; m.castShadow = true;
    return m;
  }
  update(t: number): void { this.normalMap.offset.set(t * 0.012, t * 0.009); }
}

// ---- steam plumes -----------------------------------------------------------------------------
function puffTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 60);
  g.addColorStop(0, "rgba(255,255,255,0.75)"); g.addColorStop(0.45, "rgba(255,255,255,0.35)"); g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class Plume {
  points: THREE.Points;
  private ages: Float32Array;
  private seeds: Float32Array;
  private n: number;
  private origin: THREE.Vector3;
  private radius: number;
  constructor(x: number, y: number, top: number, radius: number, count = 140) {
    this.n = count; this.origin = new THREE.Vector3(x, top, -y); this.radius = radius;
    const pos = new Float32Array(count * 3); this.ages = new Float32Array(count); this.seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) { this.ages[i] = Math.random(); this.seeds[i] = Math.random(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aAge", new THREE.BufferAttribute(this.ages, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: puffTexture() }, size: { value: 900.0 } },
      transparent: true, depthWrite: false,
      vertexShader: `attribute float aAge; varying float vAge; uniform float size;
        void main(){ vAge = aAge; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = size * (0.35 + vAge * 1.4) / -mv.z; }`,
      fragmentShader: `uniform sampler2D map; varying float vAge;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); float a = t.a * (1.0 - smoothstep(0.55, 1.0, vAge)) * smoothstep(0.0, 0.08, vAge) * 0.55;
          gl_FragColor = vec4(vec3(0.97, 0.98, 1.0), a); }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.update(0);
  }
  update(t: number): void {
    const pos = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this.n; i++) {
      const age = ((t * 0.09 + this.ages[i]) % 1);  // 0..1 over ~11 s
      const s = this.seeds[i];
      const rise = age * 95;
      const drift = age * age * 70;                 // wind to the east
      const spread = this.radius * (0.35 + age * 1.6);
      const ang = s * Math.PI * 2 + age * 0.8;
      pos.setXYZ(i, this.origin.x + Math.cos(ang) * spread * (0.4 + s * 0.6) + drift, this.origin.y + rise + Math.sin(s * 40 + t) * 1.5, this.origin.z + Math.sin(ang) * spread * (0.4 + s * 0.6));
      (this.points.geometry.getAttribute("aAge") as THREE.BufferAttribute).setX(i, age);
    }
    pos.needsUpdate = true;
    (this.points.geometry.getAttribute("aAge") as THREE.BufferAttribute).needsUpdate = true;
  }
}
