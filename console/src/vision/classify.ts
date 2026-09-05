// Assign a relative temperature (0 cold .. 1 hot) to every scene object from what it is, cached per object.
import * as THREE from "three";

export type Thermal = { t: number; hidden?: boolean };

const CACHE = new WeakMap<THREE.Object3D, Thermal>();

function mapUrl(m: THREE.Material | undefined): string {
  const map = (m as THREE.MeshStandardMaterial | undefined)?.map as THREE.Texture | undefined;
  const src = (map?.image as { currentSrc?: string; src?: string } | undefined);
  return (src?.currentSrc ?? src?.src ?? "").toLowerCase();
}

function firstMaterial(o: THREE.Object3D): THREE.Material | undefined {
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  return Array.isArray(m) ? m[0] : m;
}

function ancestorNames(o: THREE.Object3D): string {
  let s = "";
  for (let p: THREE.Object3D | null = o; p; p = p.parent) s += " " + p.name;
  return s.toLowerCase();
}

/** Classify one object. Names come from scene.ts / details.ts; geometry and material types cover the unnamed detail groups. */
export function thermalOf(o: THREE.Object3D): Thermal {
  const hit = CACHE.get(o);
  if (hit) return hit;
  const r = classify(o);
  CACHE.set(o, r);
  return r;
}

function classify(o: THREE.Object3D): Thermal {
  if ((o as THREE.Sprite).isSprite) return { t: 0, hidden: true };
  if ((o as THREE.Points).isPoints) return { t: 1.0 };                       // steam plumes
  const names = ancestorNames(o);
  const mesh = o as THREE.Mesh;
  const geo = mesh.geometry as THREE.BufferGeometry | undefined;
  const gtype = geo?.type ?? "";
  const params = (geo as THREE.BoxGeometry | undefined)?.parameters as Record<string, number> | undefined;
  const mat = firstMaterial(o);
  const url = mapUrl(mat);

  if (o.name === "ground") return { t: 0.30 };
  if (names.includes("woodland")) return { t: 0.20 };
  if (o.name === "cooling_pond") return { t: 0.06 };
  if (names.includes("person")) return { t: 0.95 };
  if (names.includes("vehicle")) {
    if (gtype === "CylinderGeometry") return { t: 0.80 };                    // wheels and brakes
    if (mat && (mat as THREE.MeshPhysicalMaterial).clearcoat === undefined && (mat as THREE.MeshStandardMaterial).color?.getHex() === 0x0d1a26) return { t: 0.45 };
    return { t: 0.72 };                                                        // engine and body just driven in
  }
  if (names.includes("crate")) return { t: 0.38 };
  if (/drone-\d/.test(o.name) || /drone-\d/.test(names)) return { t: 0.70 };
  if (o.name.startsWith("transformer")) return { t: 0.92 };
  if (o.name.startsWith("cooling_tower")) return { t: 0.62 };
  if (o.name === "reactor_containment") return { t: 0.48 };
  if (o.name === "turbine_hall") return { t: 0.60 };
  if (o.name === "control_building") return { t: 0.46 };
  if (o.name === "maintenance_shed") return { t: 0.40 };
  if (o.name.startsWith("fence_")) return { t: 0.36 };
  if (o.name.startsWith("pad_")) return { t: 0.42 };
  if ((o as THREE.InstancedMesh).isInstancedMesh) {
    if (gtype === "BoxGeometry" && params && Math.abs(params.height - 3.5) < 0.01) return { t: 0.74 };  // switchyard insulator stacks
    if (gtype === "CylinderGeometry") return { t: 0.34 };                    // fence posts and rails
    return { t: 0.30 };
  }
  if (url.includes("asphalt")) return { t: 0.52 };
  if (url.includes("concrete")) return { t: 0.42 };
  if (url.includes("gravel")) return { t: 0.45 };
  if (url.includes("metal_plate")) return { t: 0.70 };
  if (gtype === "TorusGeometry") return { t: 0.78 };                          // stack rings
  if (gtype === "CylinderGeometry") {
    const h = params?.height ?? 0;
    if (h > 20) return { t: 0.82 };                                           // chimney stack body
    if (h > 5) return { t: 0.30 };                                            // light poles
    return { t: 0.68 };                                                       // pipes in racks
  }
  if (mat && (mat as THREE.MeshStandardMaterial).emissive && (mat as THREE.MeshStandardMaterial).emissiveIntensity > 0.5) return { t: 0.62 };  // lit windows / lamps
  if (gtype === "BoxGeometry" && params && params.height < 0.1) return { t: 0.50 };  // road, lot, markings
  return { t: 0.44 };
}
