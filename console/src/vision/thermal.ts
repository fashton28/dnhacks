// Thermal (LWIR) mode: swap every material for a flat "temperature" material, then palette + sensor post-process.
import * as THREE from "three";
import { thermalOf } from "./classify";

export type Palette = "ironbow" | "whitehot";

const PLUME_VERT = `attribute float aAge; varying float vAge; uniform float size;
  void main(){ vAge = aAge; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
    gl_PointSize = size * (0.6 + vAge * 2.2) / -mv.z; }`;
const PLUME_FRAG = `varying float vAge;
  void main(){ float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard;
    float a = exp(-d * d * 14.0) * (1.0 - smoothstep(0.45, 1.0, vAge)) * smoothstep(0.0, 0.06, vAge);
    float t = mix(0.5, 1.0, pow(1.0 - vAge, 1.5));   // fresh steam is hottest, cooling as it drifts
    gl_FragColor = vec4(vec3(t), a * 0.9); }`;

const POST_FRAG = `
  uniform sampler2D tTemp; uniform vec2 texel; uniform float time; uniform int palette; varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)) + time * 7.0) * 43758.5453); }
  vec3 ironbow(float t){
    t = clamp(t, 0.0, 1.0);
    vec3 c = mix(vec3(0.02, 0.0, 0.08), vec3(0.35, 0.0, 0.55), smoothstep(0.0, 0.25, t));
    c = mix(c, vec3(0.85, 0.05, 0.15), smoothstep(0.2, 0.5, t));
    c = mix(c, vec3(1.0, 0.55, 0.05), smoothstep(0.45, 0.75, t));
    c = mix(c, vec3(1.0, 0.95, 0.55), smoothstep(0.7, 0.92, t));
    c = mix(c, vec3(1.0), smoothstep(0.9, 1.0, t));
    return c; }
  void main(){
    // optics: soft 5-tap blur, like a microbolometer behind a germanium lens
    float t = texture2D(tTemp, vUv).r * 0.4
      + (texture2D(tTemp, vUv + vec2(texel.x, 0.0)).r + texture2D(tTemp, vUv - vec2(texel.x, 0.0)).r
      +  texture2D(tTemp, vUv + vec2(0.0, texel.y)).r + texture2D(tTemp, vUv - vec2(0.0, texel.y)).r) * 0.15;
    // fixed-pattern column noise + temporal noise, AGC contrast stretch
    float col = (hash(vec2(floor(vUv.x * 800.0), 3.0)) - 0.5) * 0.02;
    t += col + (hash(vUv * 900.0) - 0.5) * 0.045;
    // AGC: the scene spans roughly 0.05 .. 1.0; keep hot sources saturated but lift the cold end for texture
    t = clamp((t - 0.02) * 0.98, 0.0, 1.0);
    t = pow(t, 0.9);
    t *= 1.0 - 0.18 * dot(vUv - 0.5, vUv - 0.5) * 2.0;
    vec3 c = palette == 0 ? ironbow(t) : vec3(t);
    // legend bar on the right
    vec2 px = vUv / texel;
    vec2 size = 1.0 / texel;
    float barX0 = size.x - 26.0, barX1 = size.x - 14.0, barY0 = size.y * 0.25, barY1 = size.y * 0.75;
    if (px.x >= barX0 - 2.0 && px.x <= barX1 + 2.0 && px.y >= barY0 - 2.0 && px.y <= barY1 + 2.0) {
      c = vec3(0.05);
      if (px.x >= barX0 && px.x <= barX1 && px.y >= barY0 && px.y <= barY1) {
        float v = (px.y - barY0) / (barY1 - barY0);
        c = palette == 0 ? ironbow(v) : vec3(v);
      }
      // ticks every quarter
      for (int i = 0; i <= 4; i++) { float ty = barY0 + (barY1 - barY0) * float(i) / 4.0; if (abs(px.y - ty) < 0.7 && px.x < barX0 && px.x > barX0 - 6.0) c = vec3(0.9); }
    }
    // reticle
    vec2 cpx = px - size * 0.5;
    if ((abs(cpx.x) < 0.8 && abs(cpx.y) > 6.0 && abs(cpx.y) < 22.0) || (abs(cpx.y) < 0.8 && abs(cpx.x) > 6.0 && abs(cpx.x) < 22.0)) c = mix(c, vec3(1.0), 0.8);
    // corner brackets
    vec2 e = min(px, size - px);
    if ((e.x < 18.0 && e.y < 1.5 && e.y >= 0.0) || (e.y < 18.0 && e.x < 1.5 && e.x >= 0.0)) c = vec3(0.9);
    gl_FragColor = vec4(c, 1.0);
  }`;

export class ThermalPass {
  palette: Palette = "ironbow";
  private target: THREE.WebGLRenderTarget;
  private mats = new Map<string, THREE.Material>();
  private plumeMat = new THREE.ShaderMaterial({ uniforms: { size: { value: 2600.0 } }, vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG, transparent: true, depthWrite: false });
  private saved: { o: THREE.Object3D; m: THREE.Material | THREE.Material[]; visible: boolean }[] = [];
  private post: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bg = new THREE.Color(0.02, 0.02, 0.02);

  private renderer: THREE.WebGLRenderer;
  constructor(renderer: THREE.WebGLRenderer, w: number, h: number) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    this.post = new THREE.ShaderMaterial({
      uniforms: { tTemp: { value: this.target.texture }, texel: { value: new THREE.Vector2(1 / w, 1 / h) }, time: { value: 0 }, palette: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: POST_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post);
    this.postScene.add(this.quad);
  }

  private material(t: number, src: THREE.Material): THREE.Material {
    const std = src as THREE.MeshStandardMaterial;
    const alphaKey = std.alphaMap ? std.alphaMap.uuid : "";
    const map = std.map && !std.alphaMap ? std.map : null;  // albedo texture modulates apparent temperature (emissivity variation)
    const key = `${t.toFixed(3)}|${alphaKey}|${map ? map.uuid : ""}|${src.side}`;
    let m = this.mats.get(key);
    if (!m) {
      // MeshBasic multiplies colour by the texel; textures average about 0.45 luminance, so scale to land on t
      const c = map ? t / 0.45 : t;
      m = new THREE.MeshBasicMaterial({ color: new THREE.Color(c, c, c), map, side: src.side, fog: false, toneMapped: false,
        alphaMap: std.alphaMap ?? null, alphaTest: std.alphaMap ? (std.alphaTest || 0.12) : 0, transparent: false });
      this.mats.set(key, m);
    }
    return m;
  }

  private swapIn(scene: THREE.Scene): void {
    this.saved.length = 0;
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!(mesh.isMesh || (o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite)) return;
      const cls = thermalOf(o);
      this.saved.push({ o, m: mesh.material, visible: o.visible });
      if (cls.hidden) { o.visible = false; return; }
      if ((o as THREE.Points).isPoints) { mesh.material = this.plumeMat; return; }
      const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const tm = this.material(cls.t, src);
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => tm) : tm;
    });
  }

  private swapOut(): void {
    for (const s of this.saved) { (s.o as THREE.Mesh).material = s.m; s.o.visible = s.visible; }
    this.saved.length = 0;
  }

  render(scene: THREE.Scene, camera: THREE.Camera, out: THREE.WebGLRenderTarget | null, time: number): void {
    const r = this.renderer;
    const bg = scene.background, fog = scene.fog, env = scene.environment;
    const tone = r.toneMapping;
    scene.background = this.bg; scene.fog = null; scene.environment = null;
    r.toneMapping = THREE.NoToneMapping;
    this.swapIn(scene);
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    this.swapOut();
    scene.background = bg; scene.fog = fog; scene.environment = env;
    this.post.uniforms.time.value = time;
    this.post.uniforms.palette.value = this.palette === "ironbow" ? 0 : 1;
    r.setRenderTarget(out);
    r.render(this.postScene, this.postCam);
    r.setRenderTarget(null);
    r.toneMapping = tone;
  }
}
