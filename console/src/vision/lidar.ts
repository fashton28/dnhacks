// LiDAR mode: depth pass -> range image with height/range colour ramp, depth-derived shading, scan pattern and range legend.
import * as THREE from "three";

const POST_FRAG = `
  #include <packing>
  uniform sampler2D tDepth; uniform vec2 texel; uniform float near; uniform float far; uniform float maxRange; uniform float time;
  uniform mat4 invProj; uniform mat4 camWorld; uniform float camAlt;
  varying vec2 vUv;
  float viewZ(vec2 uv){ float d = unpackRGBAToDepth(texture2D(tDepth, uv)); return perspectiveDepthToViewZ(d, near, far); }
  vec3 viewPos(vec2 uv){
    float z = viewZ(uv);
    vec4 clip = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    vec4 v = invProj * clip; v /= v.w;
    return v.xyz * (z / v.z); }
  vec3 ramp(float t){
    // turbo-like range ramp: near = red/yellow, far = blue/violet
    t = clamp(t, 0.0, 1.0);
    vec3 c = mix(vec3(1.0, 0.25, 0.1), vec3(1.0, 0.85, 0.15), smoothstep(0.0, 0.25, t));
    c = mix(c, vec3(0.2, 0.9, 0.4), smoothstep(0.2, 0.5, t));
    c = mix(c, vec3(0.1, 0.55, 1.0), smoothstep(0.45, 0.8, t));
    c = mix(c, vec3(0.35, 0.15, 0.7), smoothstep(0.75, 1.0, t));
    return c; }
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main(){
    vec2 px = vUv / texel; vec2 size = 1.0 / texel;
    float d = unpackRGBAToDepth(texture2D(tDepth, vUv));
    vec3 c = vec3(0.01, 0.015, 0.02);
    if (d < 0.9999) {
      vec3 p = viewPos(vUv);
      float range = length(p);
      vec3 pw = (camWorld * vec4(p, 1.0)).xyz;             // world position: y is up
      float agl = clamp(pw.y / max(camAlt, 5.0), 0.0, 1.0);
      // normal from depth derivatives for solid shading
      vec3 dx = viewPos(vUv + vec2(texel.x, 0.0)) - p;
      vec3 dy = viewPos(vUv + vec2(0.0, texel.y)) - p;
      vec3 n = normalize(cross(dx, dy));
      float shade = 0.7 + 0.3 * abs(dot(n, normalize(-p)));
      vec3 col = ramp(range / maxRange);
      col = mix(col, col * vec3(1.2, 1.2, 0.85), agl * 0.5);
      // point-cloud look: one return per 2x2 cell, cells dropping out with range; returns are bright, gaps near-black
      vec2 cell = floor(px / 2.0);
      float isDot = (mod(floor(px.x), 2.0) < 1.0 && mod(floor(px.y), 2.0) < 1.0) ? 1.0 : 0.0;
      float density = 1.0 - smoothstep(0.3, 1.0, range / maxRange) * 0.7;
      float drop = hash(cell + floor(time * 2.0));
      float grazing = smoothstep(0.0, 0.25, abs(dot(n, normalize(-p))));   // grazing surfaces return less
      if (isDot > 0.5 && drop < density * (0.5 + 0.5 * grazing)) c = col * shade * (1.35 + 0.3 * hash(cell));
      else c = col * 0.12;
    }
    // range legend bottom-left
    float bx0 = 16.0, bx1 = size.x * 0.42, by0 = 14.0, by1 = 22.0;
    if (px.x >= bx0 - 2.0 && px.x <= bx1 + 2.0 && px.y >= by0 - 2.0 && px.y <= by1 + 2.0) {
      c = vec3(0.05);
      if (px.x >= bx0 && px.x <= bx1 && px.y >= by0 && px.y <= by1) c = ramp((px.x - bx0) / (bx1 - bx0));
      for (int i = 0; i <= 5; i++) { float tx = bx0 + (bx1 - bx0) * float(i) / 5.0; if (abs(px.x - tx) < 0.7 && px.y > by1 && px.y < by1 + 6.0) c = vec3(0.9); }
    }
    // corner brackets and centre mark
    vec2 e = min(px, size - px);
    if ((e.x < 18.0 && e.y < 1.5) || (e.y < 18.0 && e.x < 1.5)) c = vec3(0.6, 0.9, 1.0);
    vec2 cpx = px - size * 0.5;
    if ((abs(cpx.x) < 0.8 && abs(cpx.y) < 10.0) || (abs(cpx.y) < 0.8 && abs(cpx.x) < 10.0)) c = mix(c, vec3(0.6, 0.9, 1.0), 0.8);
    gl_FragColor = vec4(c, 1.0);
  }`;

export class LidarPass {
  maxRange = 160;
  private target: THREE.WebGLRenderTarget;
  private depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  private post: THREE.ShaderMaterial;
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private hidden: THREE.Object3D[] = [];

  private renderer: THREE.WebGLRenderer;
  constructor(renderer: THREE.WebGLRenderer, w: number, h: number) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.post = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: this.target.texture }, texel: { value: new THREE.Vector2(1 / w, 1 / h) }, near: { value: 0.1 }, far: { value: 1000 },
        maxRange: { value: this.maxRange }, time: { value: 0 }, invProj: { value: new THREE.Matrix4() }, camWorld: { value: new THREE.Matrix4() }, camAlt: { value: 20 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: POST_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post));
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, out: THREE.WebGLRenderTarget | null, time: number): void {
    const r = this.renderer;
    // steam and labels give no returns
    this.hidden.length = 0;
    scene.traverse((o) => { if (((o as THREE.Points).isPoints || (o as THREE.Sprite).isSprite) && o.visible) { o.visible = false; this.hidden.push(o); } });
    const bg = scene.background, fog = scene.fog, override = scene.overrideMaterial;
    scene.background = null; scene.fog = null; scene.overrideMaterial = this.depthMat;
    r.setRenderTarget(this.target);
    r.setClearColor(0xffffff, 1);
    r.clear();
    r.render(scene, camera);
    scene.background = bg; scene.fog = fog; scene.overrideMaterial = override;
    for (const o of this.hidden) o.visible = true;
    const u = this.post.uniforms;
    u.near.value = camera.near; u.far.value = camera.far; u.time.value = time; u.maxRange.value = this.maxRange;
    (u.invProj.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (u.camWorld.value as THREE.Matrix4).copy(camera.matrixWorld);
    u.camAlt.value = camera.position.y;
    r.setRenderTarget(out);
    r.render(this.postScene, this.postCam);
    r.setRenderTarget(null);
  }
}
