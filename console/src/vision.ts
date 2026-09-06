// Vision modes for the Drone view: what the Drone's sensor package "sees". Owned by the vision workstream.
import * as THREE from "three";
import type { SiteScene } from "./scene";
import { LidarPass } from "./vision/lidar";
import { ThermalPass, type Palette } from "./vision/thermal";

export type VisionMode = "rgb" | "thermal" | "lidar";
export const VISION_MODES: VisionMode[] = ["rgb", "thermal", "lidar"];

export class VisionModes {
  private _mode: VisionMode = "rgb";
  private renderer: THREE.WebGLRenderer;
  private world: SiteScene;
  private thermal: ThermalPass | null = null;
  private lidar: LidarPass | null = null;
  private w = 800;
  private h = 480;

  constructor(renderer: THREE.WebGLRenderer, world: SiteScene) {
    this.renderer = renderer;
    this.world = world;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x > 0 && size.y > 0) { this.w = size.x; this.h = size.y; }
  }

  get mode(): VisionMode { return this._mode; }
  set mode(m: VisionMode) {
    if (!VISION_MODES.includes(m) || m === this._mode) return;
    this._mode = m;
    window.dispatchEvent(new CustomEvent("argus-vision-mode", { detail: m }));
  }

  /** Thermal palette: "ironbow" (default) or "whitehot". */
  set palette(p: Palette) { this.thermalPass().palette = p; }
  get palette(): Palette { return this.thermalPass().palette; }

  private thermalPass(): ThermalPass { return this.thermal ??= new ThermalPass(this.renderer, this.w, this.h); }
  private lidarPass(): LidarPass { return this.lidar ??= new LidarPass(this.renderer, this.w, this.h); }

  /** Render the Drone camera in the current mode into `target` (null = canvas). */
  render(camera: THREE.PerspectiveCamera, target: THREE.WebGLRenderTarget | null): void {
    const t = performance.now() / 1000;
    if (this._mode === "thermal") { this.thermalPass().render(this.world.scene, camera, target, t); return; }
    if (this._mode === "lidar") { this.lidarPass().render(this.world.scene, camera, target, t); return; }
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.world.scene, camera);
    this.renderer.setRenderTarget(null);
  }

  /** Thermal mode only: the calibrated per-pixel temperature map of the last render (see ThermalPass.readTemperature). */
  readTemperature(): { width: number; height: number; data: Uint8Array } | null {
    return this._mode === "thermal" && this.thermal ? this.thermal.readTemperature() : null;
  }

  /** Whether the RGB post shader (grain, vignette) should run after this mode. */
  get usesRgbPost(): boolean { return this._mode === "rgb"; }
}
