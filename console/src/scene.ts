// The Site scene: built from site.json (the same numbers as site.geojson). Three.js is Y-up, so ENU (x east, y north, z up)
// maps to three (x = east, y = up, z = -north). Helpers keep that mapping in one place.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { Terrain, TERRAIN_SIZE, terrainHeight } from "./terrain";
import { buildWoodland, forestCover, placeTrees, type WoodlandOptions } from "./vegetation";
import { Plume, Pond, facadeMaterial, lightPole, parkingLot, pipeRack, roofPlant, stack } from "./details";
import type { SceneProp, SceneState, DroneState } from "./hub";
import { latlonToEnu } from "./geo";

export type Site = any;

export const enuToThree = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
/** compass heading (deg, 0 north, clockwise) -> three.js yaw about +Y for an object whose nose is -Z */
export const headingToYaw = (deg: number) => -deg * Math.PI / 180;

const ASSETS = "./assets";
const texLoader = new THREE.TextureLoader();
const gltfLoader = new GLTFLoader();

function tex(path: string, repeat: [number, number], srgb = false): THREE.Texture {
  const t = texLoader.load(path);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** PBR material from a Poly Haven texture set, tiled `repeat` times over the surface. */
function pbr(id: string, repeat: [number, number], extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  const base = `${ASSETS}/textures/${id}`;
  return new THREE.MeshStandardMaterial({
    map: tex(`${base}/diffuse.jpg`, repeat, true),
    normalMap: tex(`${base}/normal.jpg`, repeat),
    roughnessMap: tex(`${base}/roughness.jpg`, repeat),
    aoMap: tex(`${base}/ao.jpg`, repeat),
    roughness: 1.0,
    metalness: 0.0,
    ...extra,
  });
}

/** Large-scale variation for the ground: blotchy noise so the tiled grass does not read as a pattern from altitude. */
function macroNoise(size = 1024, seed = 3): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const r = 20 + rnd() * 140;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    const v = Math.floor(70 + rnd() * 120);
    g.addColorStop(0, `rgba(${v},${v},${v},${0.25 + rnd() * 0.35})`);
    g.addColorStop(1, `rgba(${v},${v},${v},0)`);
    ctx.save(); ctx.translate(rnd() * size, rnd() * size); ctx.scale(1, 0.5 + rnd()); ctx.fillStyle = g; ctx.fillRect(-r, -r, 2 * r, 2 * r); ctx.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const mat = {
  fencePost: new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.55, metalness: 0.8 }),
  gatePost: new THREE.MeshStandardMaterial({ color: 0xd9a51d, roughness: 0.5, metalness: 0.4 }),
  drone: new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.45, metalness: 0.5 }),
  rotor: new THREE.MeshStandardMaterial({ color: 0x8892a0, roughness: 0.4, metalness: 0.6, transparent: true, opacity: 0.6 }),
  vehicle: new THREE.MeshPhysicalMaterial({ color: 0x7a1414, roughness: 0.35, metalness: 0.6, clearcoat: 1.0, clearcoatRoughness: 0.08 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0d1a26, roughness: 0.1, metalness: 0.9 }),
  tyre: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.95 }),
  person: new THREE.MeshStandardMaterial({ color: 0x2b4c8c, roughness: 0.8 }),
  skin: new THREE.MeshStandardMaterial({ color: 0xc9967a, roughness: 0.7 }),
  tree: new THREE.MeshStandardMaterial({ color: 0x2c5a2a, roughness: 1.0 }),
  trunk: new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1.0 }),
  padPaint: new THREE.MeshStandardMaterial({ color: 0xb9b3a4, roughness: 1.0, metalness: 0 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x8c8f93, roughness: 0.75, metalness: 0.4 }),
};

export class SiteScene {
  scene = new THREE.Scene();
  /** Fence sections live in one InstancedMesh; this maps section id to its instance. */
  fenceMatrices = new Map<string, { index: number; matrix: THREE.Matrix4 }>();
  fenceMesh: THREE.InstancedMesh | null = null;
  drones = new Map<string, THREE.Group>();
  props = new THREE.Group();
  anchor: { lat: number; lon: number };
  site: Site;
  sun: THREE.DirectionalLight;
  quality: "high" | "low";
  terrain!: Terrain;
  private models = new Map<string, Promise<THREE.Group>>();
  private animated: { update(t: number): void }[] = [];
  private composer: EffectComposer | null = null;
  private composerSize = new THREE.Vector2();
  private woodOpts!: WoodlandOptions;

  constructor(site: Site, renderer: THREE.WebGLRenderer, quality: "high" | "low" = "high") {
    this.site = site;
    this.quality = quality;
    this.anchor = site.anchor;
    this.scene.background = new THREE.Color(0xc4d3e0);
    // exponential haze: distant hills and the tree line fade toward the sky colour
    this.scene.fog = new THREE.FogExp2(0xc9d6e2, quality === "high" ? 0.00062 : 0.0005);
    this.sun = this.lights();
    this.sky(renderer);
    this.woodOpts = {
      size: TERRAIN_SIZE, exclusionHalf: this.site.fences.outer.half + 15, bands: this.site.trees.bands,
      bandDensity: 0.016, hillDensity: 0.0075, heightAt: terrainHeight, seed: this.site.trees.seed, densityScale: quality === "high" ? 1 : 0.35,
    };
    this.ground();
    this.buildings();
    this.fencing();
    this.padsAndRoad();
    this.woodland();
    this.waterAndPlumes();
    this.siteDetails();
    this.scene.add(this.props);
  }

  heightAt(x: number, y: number): number { return terrainHeight(x, y); }

  private lights(): THREE.DirectionalLight {
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.1);
    sun.position.set(-260, 360, 140);   // roughly the HDRI's sun: west-south-west, 48 degrees up
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = cam.bottom = -240; cam.right = cam.top = 240; cam.near = 50; cam.far = 1200;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.06;
    sun.shadow.radius = 3;
    this.scene.add(sun);
    return sun;
  }

  private sky(renderer: THREE.WebGLRenderer) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    new RGBELoader().load(`${ASSETS}/hdri/kloofendal_48d_partly_cloudy_puresky_4k.hdr`, (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
      this.scene.environmentIntensity = 0.9;
      this.scene.background = hdr;
      this.scene.backgroundIntensity = 1.0;
    });
  }

  private ground() {
    const size = TERRAIN_SIZE;
    const tile = 6;  // metres per lawn tile
    const m = pbr("leafy_grass", [size / tile, size / tile]);
    const macro = macroNoise();
    const rough = pbr("aerial_grass_rock", [size / 14, size / 14]).map!;
    const worn = pbr("sparse_grass", [size / 5, size / 5]).map!;
    const wood = pbr("forest_ground_04", [size / 7, size / 7]).map!;
    const inner = this.site.fences.outer.half + 12;  // lawn is maintained out to a little past the outer fence
    m.onBeforeCompile = (shader) => {
      shader.uniforms.macroMap = { value: macro };
      shader.uniforms.roughMap = { value: rough };
      shader.uniforms.wornMap = { value: worn };
      shader.uniforms.woodMap = { value: wood };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float aWood;\nvarying vec3 vWorldPos;\nvarying vec3 vWorldNormal;\nvarying float vWood;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWorldNormal = normalize(mat3(modelMatrix) * objectNormal);\nvWood = aWood;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <map_pars_fragment>", "#include <map_pars_fragment>\nuniform sampler2D macroMap;\nuniform sampler2D roughMap;\nuniform sampler2D wornMap;\nuniform sampler2D woodMap;\nvarying vec3 vWorldPos;\nvarying vec3 vWorldNormal;\nvarying float vWood;")
        .replace("#include <map_fragment>", `
          float macro = texture2D( macroMap, vMapUv * 5.5 ).r;
          float macro2 = texture2D( macroMap, vMapUv * 2.1 + vec2( 0.5 ) ).r;
          // anti-tiling: two lawn samples at different scale and rotation, blended by low-frequency noise
          vec2 uvB = mat2( 0.62, -0.78, 0.78, 0.62 ) * vMapUv * 0.61 + vec2( 0.37, 0.71 );
          vec4 lawn = mix( texture2D( map, vMapUv ), texture2D( map, uvB ), smoothstep( 0.35, 0.65, macro2 ) );
          vec4 wornc = texture2D( wornMap, vMapUv * ${(tile / 5).toFixed(3)} );
          vec4 roughc = texture2D( roughMap, vMapUv * ${(tile / 14).toFixed(3)} );
          vec4 woodc = texture2D( woodMap, vMapUv * ${(tile / 7).toFixed(3)} );
          // Poly Haven's lawn is autumn brown: grade toward a maintained green, keep the worn patches earthy
          lawn.rgb = mix( lawn.rgb, lawn.rgb * vec3( 0.55, 1.05, 0.38 ), 0.85 ) * 0.95;
          wornc.rgb = wornc.rgb * vec3( 1.25, 1.35, 0.9 ) * 1.35;
          roughc.rgb = mix( roughc.rgb, roughc.rgb * vec3( 0.7, 1.0, 0.45 ), 0.7 ) * 0.9;
          woodc.rgb = woodc.rgb * vec3( 0.85, 0.9, 0.7 ) * 0.9;
          float wornMix = smoothstep( 0.68, 0.9, macro );
          float dist = max( abs( vWorldPos.x ), abs( vWorldPos.z ) );
          float outside = smoothstep( ${inner.toFixed(1)}, ${(inner + 40).toFixed(1)}, dist );
          vec4 c = mix( lawn, wornc, wornMix * 0.8 );
          // beyond the maintained perimeter: rougher meadow, forest floor under the woods, bare rock on slopes
          vec4 meadow = mix( roughc, lawn * vec4( 0.82, 0.9, 0.72, 1.0 ), 0.3 + 0.3 * macro2 ) * 0.92;
          c = mix( c, meadow, outside );
          c = mix( c, woodc, outside * smoothstep( 0.25, 0.8, vWood ) );
          float slope = 1.0 - clamp( vWorldNormal.y, 0.0, 1.0 );
          vec4 rock = vec4( vec3( 0.42, 0.40, 0.36 ) * ( 0.8 + 0.4 * macro ), 1.0 );
          c = mix( c, rock, smoothstep( 0.22, 0.45, slope ) );
          c.rgb *= mix( 0.8, 1.1, macro );
          diffuseColor *= c;`);
    };
    this.terrain = new Terrain(m, (x, y) => forestCover(x, y, this.woodOpts));
    this.scene.add(this.terrain.mesh);
    // gravel apron under the switchyard
    const [x0, x1, y0, y1] = this.site.switchyard ? [this.siteX0(), this.siteX1(), this.siteY0(), this.siteY1()] : [0, 0, 0, 0];
    const gravel = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 + 14, y1 - y0 + 14), pbr("gravelly_sand", [(x1 - x0 + 14) / 4, (y1 - y0 + 14) / 4]));
    gravel.rotation.x = -Math.PI / 2;
    gravel.position.copy(enuToThree((x0 + x1) / 2, (y0 + y1) / 2, 0.02));
    gravel.receiveShadow = true;
    this.scene.add(gravel);
  }
  private siteX0() { return Math.min(...this.site.switchyard.stacks.map((s: any) => s.x)); }
  private siteX1() { return Math.max(...this.site.switchyard.stacks.map((s: any) => s.x)); }
  private siteY0() { return Math.min(...this.site.switchyard.stacks.map((s: any) => s.y)); }
  private siteY1() { return Math.max(...this.site.switchyard.stacks.map((s: any) => s.y)); }

  private box(id: string, x: number, y: number, size: [number, number, number], m: THREE.Material | THREE.Material[], yaw = 0) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[2], size[1]), m);
    mesh.position.copy(enuToThree(x, y, size[2] / 2));
    mesh.rotation.y = -yaw;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = id;
    this.scene.add(mesh);
    return mesh;
  }

  private wallMaterials(texId: string, size: [number, number, number], tile: number): THREE.Material[] {
    // BoxGeometry face order: +x, -x, +y(top), -y(bottom), +z, -z ; three's y is up, so size[2] is the height
    const side = (w: number) => pbr(texId, [w / tile, size[2] / tile]);
    return [side(size[1]), side(size[1]), mat.roof, mat.roof, side(size[0]), side(size[0])];
  }

  private buildings() {
    const texFor: Record<string, string> = { factory: "corrugated_iron_02", concrete: "concrete_wall_008", metal: "corrugated_iron_02", steel: "metal_plate" };
    for (const b of this.site.buildings) {
      if (b.kind === "box") {
        const t = texFor[b.material] ?? "concrete_wall_008";
        const tile = t === "metal_plate" ? 2 : 4;
        if (b.material === "concrete" || b.material === "factory") {
          // window facades: office style for concrete, industrial glazing strip for the turbine hall
          const style = b.material === "concrete" ? "office" : "industrial";
          const side = (w: number) => facadeMaterial(w, b.size[2], style);
          this.box(b.id, b.x, b.y, b.size, [side(b.size[1]), side(b.size[1]), mat.roof, mat.roof, side(b.size[0]), side(b.size[0])]);
          this.scene.add(roofPlant(b.x, b.y, b.size, b.id.length * 7));
        } else {
          this.box(b.id, b.x, b.y, b.size, this.wallMaterials(t, b.size, tile));
        }
      } else if (b.kind === "cylinder") {
        const circ = 2 * Math.PI * b.radius;
        const m = pbr("precast_concrete_wall", [circ / 6, b.height / 6]);
        const body = new THREE.Mesh(new THREE.CylinderGeometry(b.radius, b.radius * (b.dome > 0 ? 1 : 1.12), b.height, 64, 1, false), m);
        body.position.copy(enuToThree(b.x, b.y, b.height / 2));
        body.castShadow = body.receiveShadow = true;
        body.name = b.id;
        this.scene.add(body);
        const cap = new THREE.Mesh(new THREE.CircleGeometry(b.radius * (b.dome > 0 ? 1 : 1.0), 64), pbr("concrete_wall_008", [b.radius / 3, b.radius / 3]));
        cap.rotation.x = -Math.PI / 2;
        cap.position.copy(enuToThree(b.x, b.y, b.height + 0.01));
        cap.receiveShadow = true;
        this.scene.add(cap);
        if (b.dome > 0) {
          const dome = new THREE.Mesh(new THREE.SphereGeometry(b.radius, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2), pbr("precast_concrete_wall", [circ / 6, b.radius / 6]));
          dome.scale.y = b.dome / b.radius;
          dome.position.copy(enuToThree(b.x, b.y, b.height));
          dome.castShadow = true;
          this.scene.add(dome);
        }
      }
    }
    // switchyard: insulator stacks (steel) plus GLTF power boxes as the transformers' switchgear
    const stacks = this.site.switchyard.stacks as { x: number; y: number; size: [number, number, number] }[];
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1.2, 3.5, 1.2), pbr("metal_plate", [1, 3], { metalness: 0.8, roughness: 0.5 }), stacks.length);
    const m4 = new THREE.Matrix4();
    stacks.forEach((s, i) => { m4.setPosition(enuToThree(s.x, s.y, s.size[2] / 2)); inst.setMatrixAt(i, m4); });
    inst.castShadow = inst.receiveShadow = true;
    this.scene.add(inst);
    for (const b of this.site.buildings.filter((b: any) => b.id.startsWith("transformer"))) {
      this.model("power_box_01").then((g) => {
        const o = g.clone();
        o.scale.setScalar(2.6);
        o.position.copy(enuToThree(b.x, b.y + 3.2, 0));
        this.scene.add(o);
      });
    }
  }

  private fencing() {
    const wireDiff = tex(`${ASSETS}/models/modular_chainlink_fence/textures/modular_chainlink_fence_wire_diff_1k.jpg`, [4, 1], true);
    const wireNor = tex(`${ASSETS}/models/modular_chainlink_fence/textures/modular_chainlink_fence_wire_nor_gl_1k.jpg`, [4, 1]);
    const wire = new THREE.MeshStandardMaterial({ map: wireDiff, alphaMap: wireDiff, normalMap: wireNor, transparent: true, alphaTest: 0.12, side: THREE.DoubleSide, metalness: 0.7, roughness: 0.5, color: 0xd8dde3 });
    const postGeo = new THREE.CylinderGeometry(0.045, 0.045, 1, 8);
    const railGeo = new THREE.CylinderGeometry(0.03, 0.03, 1, 8);
    railGeo.rotateZ(Math.PI / 2);
    const posts: THREE.Matrix4[] = [];
    const rails: THREE.Matrix4[] = [];
    // all fence sections in one InstancedMesh; an open section is hidden by collapsing its instance matrix
    const sections = [...this.site.fences.outer.sections, ...this.site.fences.inner.sections];
    const wireMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), wire, sections.length);
    wireMesh.name = "fences";
    wireMesh.castShadow = true;
    sections.forEach((s: any, i: number) => {
      const m4 = new THREE.Matrix4().compose(enuToThree(s.x, s.y, s.height / 2), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -s.yaw), new THREE.Vector3(s.length, s.height, 1));
      this.fenceMatrices.set(s.id, { index: i, matrix: m4 });
      wireMesh.setMatrixAt(i, m4);
      for (const k of [-1, -0.5, 0, 0.5, 1]) {
        const dx = s.yaw === 0 ? k * s.length / 2 : 0, dy = s.yaw === 0 ? 0 : k * s.length / 2;
        posts.push(new THREE.Matrix4().compose(enuToThree(s.x + dx, s.y + dy, (s.height + 0.15) / 2), new THREE.Quaternion(), new THREE.Vector3(1, s.height + 0.15, 1)));
      }
      rails.push(new THREE.Matrix4().compose(enuToThree(s.x, s.y, s.height + 0.05), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -s.yaw), new THREE.Vector3(s.length, 1, 1)));
    });
    this.fenceMesh = wireMesh;
    this.scene.add(wireMesh);
    const postMesh = new THREE.InstancedMesh(postGeo, mat.fencePost, posts.length);
    posts.forEach((m4, i) => postMesh.setMatrixAt(i, m4));
    postMesh.castShadow = true;
    this.scene.add(postMesh);
    const railMesh = new THREE.InstancedMesh(railGeo, mat.fencePost, rails.length);
    rails.forEach((m4, i) => railMesh.setMatrixAt(i, m4));
    railMesh.castShadow = true;
    this.scene.add(railMesh);
    const g = this.site.fences.gate;
    for (const y of [g.outer_y, g.inner_y]) for (const dx of [-g.width / 2, g.width / 2]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 3.2, 0.4), mat.gatePost);
      post.position.copy(enuToThree(g.x + dx, y, 1.6));
      post.castShadow = true;
      this.scene.add(post);
    }
  }

  private padsAndRoad() {
    for (const p of this.site.pads) {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(p.size, 0.08, p.size), pbr("concrete_wall_008", [1.5, 1.5]));
      pad.position.copy(enuToThree(p.x, p.y, 0.04));
      pad.receiveShadow = true;
      pad.name = p.id;
      this.scene.add(pad);
      // painted H
      const h = new THREE.Group();
      for (const [dx, w, d] of [[-1.2, 0.35, 3.2], [1.2, 0.35, 3.2], [0, 2.1, 0.35]] as const) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(w, 0.01, d), mat.padPaint); bar.position.set(dx, 0.085, 0); h.add(bar);
      }
      h.position.copy(enuToThree(p.x, p.y, 0));
      this.scene.add(h);
    }
    const r = this.site.road;
    const len = r.y1 - r.y0;
    const road = new THREE.Mesh(new THREE.BoxGeometry(r.width, 0.06, len), [mat.roof, mat.roof, pbr("asphalt_02", [r.width / 6, len / 6]), mat.roof, mat.roof, mat.roof]);
    road.position.copy(enuToThree(r.x, (r.y0 + r.y1) / 2, 0.03));
    road.receiveShadow = true;
    this.scene.add(road);
  }

  private woodland() {
    const placements = placeTrees(this.woodOpts);
    const group = buildWoodland(placements, this.quality === "high" ? 300 : 0);
    this.scene.add(group);
    (this.scene.userData as any).treeCount = placements.length;
  }

  private waterAndPlumes() {
    // cooling pond between the inner and outer fence on the west side, fed from the towers
    const pond = new Pond(-125, 30, 22, 90);
    this.scene.add(pond.mesh, pond.rim(pbr("concrete_wall_008", [4, 1])));
    this.animated.push(pond);
    for (const b of this.site.buildings.filter((b: any) => b.id.startsWith("cooling_tower"))) {
      const plume = new Plume(b.x, b.y, b.height + 1, b.radius, this.quality === "high" ? 160 : 60);
      this.scene.add(plume.points);
      this.animated.push(plume);
    }
  }

  private siteDetails() {
    const turbine = this.site.buildings.find((b: any) => b.id === "turbine_hall");
    const containment = this.site.buildings.find((b: any) => b.id === "reactor_containment");
    const control = this.site.buildings.find((b: any) => b.id === "control_building");
    if (turbine && containment) {
      // pipe rack from the turbine hall to the containment, and a stack beside the hall
      this.scene.add(pipeRack([turbine.x + 8, turbine.y + turbine.size[1] / 2], [containment.x + 8, containment.y - containment.radius], 7, 3));
      this.scene.add(stack(turbine.x - turbine.size[0] / 2 - 4, turbine.y + 4, 34, 1.6));
    }
    for (const b of this.site.buildings.filter((b: any) => b.id.startsWith("cooling_tower"))) {
      this.scene.add(pipeRack([b.x + b.radius, b.y], [b.x + 34, b.y], 4.5, 2));
    }
    // light poles along the access road and around the pads
    const r = this.site.road;
    for (let y = r.y0 + 20; y < r.y1; y += 32) {
      this.scene.add(lightPole(r.x + r.width / 2 + 1.2, y, Math.PI));
    }
    for (const p of this.site.pads) this.scene.add(lightPole(p.x + 4, p.y + 5, -Math.PI / 2));
    // parking lot beside the control building
    if (control) {
      this.scene.add(parkingLot(control.x + 32, control.y - 6, 30, 16, pbr("asphalt_02", [5, 2.5]), 91));
      this.scene.add(lightPole(control.x + 32, control.y - 16, Math.PI / 2));
    }
  }

  /** Per-frame animation hook (plumes, water). Called by the main loop with elapsed seconds. */
  update(elapsedSeconds: number, cameraPosition?: THREE.Vector3): void {
    this.animateDrones(elapsedSeconds, cameraPosition);
    for (const a of this.animated) a.update(elapsedSeconds);
    for (const g of this.props.children) {
      if (!g.userData.fire) continue;
      for (const f of g.children) {
        if (f.name === "flame") {
          const t = elapsedSeconds * 9 + f.userData.seed;
          f.scale.y = 0.7 + 0.4 * Math.abs(Math.sin(t) * Math.sin(t * 0.37 + 1)); f.scale.x = 0.85 + 0.2 * Math.sin(t * 1.7);
          f.position.y = (f.userData.h * f.scale.y) / 2 + 0.15;
          ((f as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.75 + 0.25 * Math.sin(t * 2.3);
          if (cameraPosition) { const wp = new THREE.Vector3(); f.getWorldPosition(wp); f.rotation.set(0, Math.atan2(cameraPosition.x - wp.x, cameraPosition.z - wp.z) - g.rotation.y, 0); }  // billboard about the vertical
        }
        else if (f.name === "fireglow") (f as THREE.PointLight).intensity = 34 + 12 * Math.sin(elapsedSeconds * 11) * Math.sin(elapsedSeconds * 4.3);
      }
    }
  }

  /** Render the World view through a bloom pipeline (skipped on low quality). */
  renderWorld(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    if (this.quality === "low") { renderer.render(this.scene, camera); return; }
    const size = renderer.getSize(this.sizeScratch);
    if (!this.composer) {
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(new RenderPass(this.scene, camera));
      const bloom = new UnrealBloomPass(size.clone().multiplyScalar(0.5), 0.22, 0.5, 0.92);  // bloom at half resolution
      this.composer.addPass(bloom);
      this.composer.addPass(new OutputPass());
      this.composerSize.copy(size);
    }
    if (!this.composerSize.equals(size)) { this.composer.setSize(size.x, size.y); this.composerSize.copy(size); }
    (this.composer.passes[0] as RenderPass).camera = camera;
    // Shadows are static: the sun does not move and Drones do not cast them (see droneModel). Refreshing the map every other
    // frame made frame cost alternate, which reads as judder; now it refreshes every few seconds or when the Scene changes.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = this.shadowMapNeedsUpdate(renderer);
    this.composer.render();
  }

  // ---- GLTF props --------------------------------------------------------------------------
  private model(id: string): Promise<THREE.Group> {
    if (!this.models.has(id)) {
      this.models.set(id, new Promise((resolve, reject) => {
        gltfLoader.load(`${ASSETS}/models/${id}/${id}_1k.gltf`, (g) => {
          g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = o.receiveShadow = true; } });
          this.shadowsDirty = true;
          resolve(g.scene);
        }, undefined, reject);
      }));
    }
    return this.models.get(id)!;
  }

  // ---- live state --------------------------------------------------------------------------
  private droneModel(id: string): THREE.Group {
    // A mission quadcopter (Matrice class, ~0.9 m span): rounded carbon body, folding arms, brushless motors with
    // two-blade props, landing skids, nose gimbal with a lens, nav lights (red front, green rear) and a strobe.
    const carbon = new THREE.MeshPhysicalMaterial({ color: 0x1b1d21, roughness: 0.35, metalness: 0.2, clearcoat: 0.6, clearcoatRoughness: 0.25 });
    const shell = new THREE.MeshPhysicalMaterial({ color: 0x3a3d43, roughness: 0.45, metalness: 0.1, clearcoat: 0.3 });
    const alu = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.35, metalness: 0.9 });
    const black = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.6, metalness: 0.3 });
    const lens = new THREE.MeshPhysicalMaterial({ color: 0x06111c, roughness: 0.05, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02 });
    const blade = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.2 });
    const disc = new THREE.MeshBasicMaterial({ color: 0x9aa4b0, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const g = new THREE.Group();
    const body = new THREE.Mesh(new RoundedBoxGeometry(0.30, 0.11, 0.40, 4, 0.03), carbon);
    body.castShadow = true; g.add(body);
    const top = new THREE.Mesh(new RoundedBoxGeometry(0.22, 0.06, 0.26, 4, 0.02), shell); top.position.set(0, 0.075, -0.02); top.castShadow = true; g.add(top);
    const battery = new THREE.Mesh(new RoundedBoxGeometry(0.16, 0.05, 0.12, 3, 0.015), black); battery.position.set(0, 0.125, 0.03); g.add(battery);
    const gpsPuck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.012, 20), shell); gpsPuck.position.set(0, 0.16, -0.06); g.add(gpsPuck);
    // arms + motors + props
    const rotors: THREE.Object3D[] = [];
    const armLen = 0.32;
    for (const [sx, sz] of [[1, -1], [-1, -1], [1, 1], [-1, 1]] as const) {
      const ang = Math.atan2(sz, sx);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.017, armLen, 12), carbon);
      arm.rotation.z = Math.PI / 2; arm.rotation.y = -ang;
      arm.position.set(Math.cos(ang) * (0.13 + armLen / 2), 0.02, Math.sin(ang) * (0.13 + armLen / 2));
      arm.castShadow = true; g.add(arm);
      const ex = Math.cos(ang) * (0.13 + armLen), ez = Math.sin(ang) * (0.13 + armLen);
      const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.04, 16), shell); mount.position.set(ex, 0.03, ez); g.add(mount);
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.035, 20), alu); motor.position.set(ex, 0.067, ez); g.add(motor);
      const hub = new THREE.Group(); hub.position.set(ex, 0.09, ez);
      for (const k of [0, 1]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.004, 0.028), blade); b.rotation.y = k * Math.PI / 2; b.rotation.x = 0.12; hub.add(b); }
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.012, 12), black); hub.add(cap);
      const d = new THREE.Mesh(new THREE.CircleGeometry(0.155, 32), disc); d.rotation.x = -Math.PI / 2; d.visible = false; hub.add(d);
      (hub.userData as any).disc = d;
      g.add(hub); rotors.push(hub);
      // nav light: red on the front arms (-z is the nose), green on the rear
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshStandardMaterial({ color: sz < 0 ? 0xff2a2a : 0x2aff5a, emissive: sz < 0 ? 0xff2a2a : 0x2aff5a, emissiveIntensity: 2.5 }));
      led.position.set(ex, 0.008, ez); g.add(led);
    }
    // skids
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16, 8), carbon); leg.position.set(sx * 0.11, -0.12, 0); leg.rotation.z = sx * 0.25; g.add(leg);
      const skid = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.34, 8), carbon); skid.rotation.x = Math.PI / 2; skid.position.set(sx * 0.13, -0.2, 0); g.add(skid);
    }
    // nose gimbal: yaw ring under the nose, pitch cradle, camera housing with lens
    const gimbal = new THREE.Group(); gimbal.position.set(0, -0.06, -0.19);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 20), alu); gimbal.add(ring);
    const pitch = new THREE.Group(); pitch.position.set(0, -0.045, 0); gimbal.add(pitch);
    const housing = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.055, 0.07, 3, 0.012), shell); housing.castShadow = true; pitch.add(housing);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.03, 20), black); barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 0, -0.045); pitch.add(barrel);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.016, 20), lens); glass.position.set(0, 0, -0.061); pitch.add(glass);
    g.add(gimbal);
    // strobe
    const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0 }));
    strobe.position.set(0, 0.17, 0.03); g.add(strobe);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: textLabel(id), depthTest: false, transparent: true, opacity: 0.9 }));
    label.scale.set(2.2, 0.55, 1); label.position.y = 0.75;
    g.add(label);
    g.name = id;
    g.userData.label = label;
    g.userData.rotors = rotors; g.userData.gimbalPitch = pitch; g.userData.strobe = strobe;
    return g;
  }

  /** Spin rotors of airborne Drones, pulse strobes, and tilt each gimbal to its reported pitch. */
  animateDrones(t: number, cameraPosition?: THREE.Vector3): void {
    this.smoothPoses(performance.now());
    for (const g of this.drones.values()) {
      const label = g.userData.label as THREE.Sprite | undefined;
      if (label && cameraPosition) { const d = cameraPosition.distanceTo(g.position); label.visible = d > 12; (label.material as THREE.SpriteMaterial).opacity = Math.min(0.9, (d - 12) / 20); }
      const s = (g.userData as any).state as DroneState | undefined;
      const flying = !!s && (s.armed || s.alt > 0.15);
      for (const r of (g.userData.rotors as THREE.Object3D[])) {
        if (flying) { r.rotation.y += 0.9; (r.userData.disc as THREE.Mesh).visible = true; } else { (r.userData.disc as THREE.Mesh).visible = false; }
      }
      const strobe = g.userData.strobe as THREE.Mesh;
      (strobe.material as THREE.MeshStandardMaterial).emissiveIntensity = flying ? (Math.sin(t * 6) > 0.85 ? 6 : 0.2) : 0;
      const pitch = g.userData.gimbalPitch as THREE.Group;
      const track = (g.userData as any).track as PoseTrack | undefined;
      pitch.rotation.x = -(track?.gimbal ?? s?.gimbal_pitch_deg ?? 8) * Math.PI / 180;
    }
  }

  /** Per-frame pose smoothing on (`?smooth=0` disables it for comparison). Telemetry arrives at 10 to 20 Hz; without this the
   *  aircraft and its camera jump once per sample, which reads as lag however fast the page renders. */
  smoothing = true;
  private lastAnimMs = 0;
  /** Static geometry changed (Scene props, fences, a model finished loading): every renderer refreshes its shadow map once. */
  set shadowsDirty(v: boolean) { if (v) this.shadowEpoch++; }
  private shadowEpoch = 1;
  private shadowSeen = new WeakMap<THREE.WebGLRenderer, number>();
  /** True once per renderer per Scene change. The sun is fixed and Drones cast no shadows, so nothing else can move a shadow;
   *  a periodic refresh only added a 2048^2 depth pass (and a long frame) every few seconds. */
  shadowMapNeedsUpdate(renderer: THREE.WebGLRenderer): boolean {
    if (this.shadowSeen.get(renderer) === this.shadowEpoch) return false;
    this.shadowSeen.set(renderer, this.shadowEpoch);
    return true;
  }
  private sizeScratch = new THREE.Vector2();

  updateDrone(s: DroneState): void {
    let g = this.drones.get(s.drone_id);
    if (!g) {
      g = this.droneModel(s.drone_id);
      // Drones do not cast shadows: a moving caster would force the shadow map to refresh every frame
      g.traverse((o) => { (o as THREE.Mesh).castShadow = false; });
      this.drones.set(s.drone_id, g); this.scene.add(g);
    }
    const [x, y] = latlonToEnu(this.anchor, s.lat, s.lon);
    const alt = Math.max(0, s.alt);
    const ud = g.userData as any;
    ud.state = s;
    // ENU velocity from the NED vector: east = vy, north = vx, up = -vz. Used to predict between samples.
    const roll = s.roll_deg ?? 0, pitch = s.pitch_deg ?? 0;
    const track: PoseTrack = ud.track ?? (ud.track = { x, y, alt, hdg: s.heading_deg, gimbal: s.gimbal_pitch_deg, roll, pitch, sx: x, sy: y, salt: alt, shdg: s.heading_deg, sgimbal: s.gimbal_pitch_deg, sroll: roll, spitch: pitch, vx: 0, vy: 0, vz: 0, t: performance.now() });
    track.sx = x; track.sy = y; track.salt = alt; track.shdg = s.heading_deg; track.sgimbal = s.gimbal_pitch_deg; track.sroll = roll; track.spitch = pitch;
    const airborne = s.armed || alt > 0.3;
    track.vx = airborne ? s.velocity_ned.vy : 0; track.vy = airborne ? s.velocity_ned.vx : 0; track.vz = airborne ? -s.velocity_ned.vz : 0;
    track.t = performance.now();
    if (!this.smoothing || Math.hypot(track.sx - track.x, track.sy - track.y) > 25) {
      // snap: smoothing disabled, first sample, or a teleport (reset, reconnect)
      track.x = x; track.y = y; track.alt = alt; track.hdg = s.heading_deg; track.gimbal = s.gimbal_pitch_deg; track.roll = roll; track.pitch = pitch;
      this.placeDrone(g, track);
    }
  }

  /** The pose the World and the Drone camera use: smoothed and predicted, or the raw sample when smoothing is off. */
  poseOf(droneId: string): PoseTrack | undefined { return (this.drones.get(droneId)?.userData as any)?.track; }

  private placeDrone(g: THREE.Group, p: PoseTrack): void {
    g.position.copy(enuToThree(p.x, p.y, Math.max(0.21, p.alt + 0.21)));  // skids rest on the pad
    // yaw, then pitch, then roll (intrinsic): nose is -Z, so nose-up is +X rotation and right-wing-down is -Z rotation.
    // The airframe banks into turns and pitches to accelerate exactly as the autopilot reports; the camera stays stabilized.
    g.rotation.set(THREE.MathUtils.degToRad(p.pitch), headingToYaw(p.hdg), -THREE.MathUtils.degToRad(p.roll), "YXZ");
  }

  private smoothPoses(nowMs: number): void {
    const dt = this.lastAnimMs ? Math.min(0.1, (nowMs - this.lastAnimMs) / 1000) : 0;
    this.lastAnimMs = nowMs;
    if (!this.smoothing || dt <= 0) return;
    const kPos = 1 - Math.exp(-dt / 0.12), kHdg = 1 - Math.exp(-dt / 0.06), kGim = 1 - Math.exp(-dt / 0.2), kAtt = 1 - Math.exp(-dt / 0.1);  // heading follows fast so a turn under manual control shows without lag
    for (const g of this.drones.values()) {
      const p = (g.userData as any).track as PoseTrack | undefined;
      if (!p) continue;
      // dead reckoning from the last sample, capped so a stalled link does not fly the model away
      const age = Math.min(0.3, (nowMs - p.t) / 1000);
      const tx = p.sx + p.vx * age, ty = p.sy + p.vy * age, talt = Math.max(0, p.salt + p.vz * age);
      p.x += (tx - p.x) * kPos; p.y += (ty - p.y) * kPos; p.alt += (talt - p.alt) * kPos;
      let dh = ((p.shdg - p.hdg + 540) % 360) - 180;  // shortest arc
      p.hdg = (p.hdg + dh * kHdg + 360) % 360;
      p.gimbal += (p.sgimbal - p.gimbal) * kGim;
      p.roll += (p.sroll - p.roll) * kAtt; p.pitch += (p.spitch - p.pitch) * kAtt;
      this.placeDrone(g, p);
    }
  }

  setScene(state: SceneState): void {
    this.shadowsDirty = true;
    if (this.fenceMesh) {
      const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
      for (const [id, f] of this.fenceMatrices) this.fenceMesh.setMatrixAt(f.index, state.open_fences.includes(id) ? hidden : f.matrix);
      this.fenceMesh.instanceMatrix.needsUpdate = true;
    }
    this.props.clear();
    for (const p of state.props) this.propModel(p).then((o) => { this.props.add(o); this.shadowsDirty = true; });
  }

  private async propModel(p: SceneProp): Promise<THREE.Object3D> {
    let o: THREE.Object3D;
    if (p.kind === "vehicle") {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.6, 5.2), mat.vehicle); body.position.y = 0.78; g.add(body);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.62, 1.9), mat.vehicle); cab.position.set(0, 1.38, 0.2); g.add(cab);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.4, 1.7), mat.glass); glass.position.set(0, 1.45, 0.2); g.add(glass);
      const bed = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.4, 1.9), mat.tyre); bed.position.set(0, 1.0, -1.5); g.add(bed);
      for (const [dx, dz] of [[0.95, 1.7], [-0.95, 1.7], [0.95, -1.6], [-0.95, -1.6]]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.3, 20), mat.tyre); w.rotation.z = Math.PI / 2; w.position.set(dx, 0.42, dz); g.add(w);
      }
      o = g;
    } else if (p.kind === "fire") {
      // A transformer bay on fire: scorched ground, a licking flame core (emissive, animated in animateProps), dark smoke column.
      const g = new THREE.Group(); g.name = "fire";
      const scorch = new THREE.Mesh(new THREE.CircleGeometry(4.2, 28), new THREE.MeshStandardMaterial({ color: 0x0b0a09, roughness: 1 }));
      scorch.rotation.x = -Math.PI / 2; scorch.position.y = 0.03; scorch.receiveShadow = true; g.add(scorch);
      // Flames: billboarded additive planes with a soft flame texture. The texture doubles as alphaMap so the thermal
      // camera keeps the flame shape (classify.ts reads "flame" as saturated). They flicker in update().
      const tex = flameTexture();
      for (let i = 0; i < 9; i++) {
        const w = 2.4 + Math.random() * 2.0, h = 4.0 + Math.random() * 3.5;
        const m = new THREE.MeshBasicMaterial({ map: tex, alphaMap: tex, color: i % 3 === 0 ? 0xfff0b0 : i % 3 === 1 ? 0xffa030 : 0xff5a12, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
        const f = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
        f.position.set((Math.random() - 0.5) * 4.2, h / 2 + 0.15, (Math.random() - 0.5) * 3.0); f.name = "flame"; f.userData.h = h; f.userData.w = w; f.userData.seed = Math.random() * 6.28; f.renderOrder = 2;
        g.add(f);
      }
      const ember = new THREE.Mesh(new THREE.CircleGeometry(2.6, 24), new THREE.MeshBasicMaterial({ color: 0xff6a1c, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      ember.rotation.x = -Math.PI / 2; ember.position.y = 0.06; ember.name = "ember"; g.add(ember);
      const glow = new THREE.PointLight(0xff8c2a, 40, 30, 1.6); glow.position.set(0, 2.2, 0); glow.name = "fireglow"; g.add(glow);
      const smoke = new Plume(0, 0, 2.4, 3.2, this.quality === "high" ? 700 : 240, { color: 0x2b2c2f, heat: 1.0, vigour: 1.3, opacity: 0.8, minPx: 10, size: 2200 });
      smoke.points.name = "smoke"; g.add(smoke.points); this.animated.push(smoke);
      g.userData.fire = true;
      o = g;
    } else if (p.kind === "steam") {
      // A relief vent lifting: a stub of pipe and a cool white steam column, from above indistinguishable from smoke.
      const g = new THREE.Group(); g.name = "steam";
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.6, 14), new THREE.MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.6, roughness: 0.5 }));
      pipe.position.y = 0.8; g.add(pipe);
      const steam = new Plume(0, 0, 1.6, 1.8, this.quality === "high" ? 320 : 120, { color: 0xf4f8fb, heat: 0.35, vigour: 0.9, opacity: 0.8, minPx: 9, size: 1500 });
      steam.points.name = "steam"; g.add(steam.points); this.animated.push(steam);
      o = g;
    } else if (p.kind === "person") {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.9, 4, 8), mat.person); body.position.y = 0.9; g.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), mat.skin); head.position.y = 1.65; g.add(head);
      o = g;
    } else {
      const crate = (await this.model("wooden_crate_01")).clone();
      const box = new THREE.Box3().setFromObject(crate);
      const size = box.getSize(new THREE.Vector3());
      crate.scale.setScalar(1.1 / Math.max(size.x, size.z));
      crate.position.y = -box.min.y * crate.scale.y;
      o = crate;
    }
    o.traverse((m) => { if ((m as THREE.Mesh).isMesh && !(m as THREE.Mesh).material?.hasOwnProperty("transparent")) (m as THREE.Mesh).castShadow = true; });
    o.position.add(enuToThree(p.x, p.y, p.z ?? 0));
    o.rotation.y = headingToYaw(p.yaw_deg);
    o.name = p.id;
    return o;
  }

  /** Place a camera at a Drone's pose with the gimbal pitch (0 level, 90 straight down). */
  aimDroneCamera(cam: THREE.PerspectiveCamera, s: DroneState): void {
    // the camera rides the smoothed pose so the feed moves at frame rate, not at telemetry rate
    const p = this.poseOf(s.drone_id);
    const [x, y] = p ? [p.x, p.y] : latlonToEnu(this.anchor, s.lat, s.lon);
    cam.position.copy(enuToThree(x, y, (p ? p.alt : s.alt) + 0.15));  // gimbal lens sits under the nose, ~15 cm above the skids on the pad
    const yaw = headingToYaw(p ? p.hdg : s.heading_deg);
    const pitch = -(p ? p.gimbal : s.gimbal_pitch_deg) * Math.PI / 180;
    cam.rotation.set(0, 0, 0);
    cam.rotateY(yaw);
    cam.rotateX(pitch);
  }
}

/** Last telemetry sample (s*) plus the smoothed, predicted pose actually drawn. ENU metres, altitude metres, degrees. */
export interface PoseTrack { x: number; y: number; alt: number; hdg: number; gimbal: number; roll: number; pitch: number; sx: number; sy: number; salt: number; shdg: number; sgimbal: number; sroll: number; spitch: number; vx: number; vy: number; vz: number; t: number }

/** A soft teardrop flame: bright core, orange body, feathered edges. Used as colour and alpha. */
let flameTex: THREE.CanvasTexture | null = null;
function flameTexture(): THREE.CanvasTexture {
  if (flameTex) return flameTex;
  const c = document.createElement("canvas"); c.width = 128; c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 256);
  for (let i = 0; i < 4; i++) {
    const g = ctx.createRadialGradient(64, 200 - i * 34, 4, 64, 190 - i * 30, 44 - i * 6);
    g.addColorStop(0, `rgba(255,${230 - i * 30},${150 - i * 40},${0.95 - i * 0.12})`); g.addColorStop(0.55, `rgba(255,${140 - i * 20},30,${0.55 - i * 0.08})`); g.addColorStop(1, "rgba(255,80,10,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(64, 190 - i * 30, 40 - i * 5, 62 - i * 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  flameTex = new THREE.CanvasTexture(c); flameTex.colorSpace = THREE.SRGBColorSpace;
  return flameTex;
}

function textLabel(text: string): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 512; c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "rgba(8,10,14,0.72)"; ctx.beginPath(); ctx.roundRect(8, 16, 496, 96, 24); ctx.fill();
  ctx.fillStyle = "#e6edf3"; ctx.font = "600 56px -apple-system, Inter, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 66);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
