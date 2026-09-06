/* ============================================================================
 * Drone Safety Platform — site provider (renderer side).
 * ----------------------------------------------------------------------------
 * The plant site model (home, perimeter geofence, NFZs, alt band, staging
 * points) is consumed ONLY via the site JSON described in
 * docs/SITE_CONTRACT.md. Nothing in the UI hardcodes plant geometry — every
 * coordinate is derived from the model returned here.
 *
 * Resolution order:
 *   1. window.eis.loadSiteFile()  — Electron shells (EIS_SITE_FILE on disk).
 *   2. fetch('/site.json')        — vite dev/preview (siteFilePlugin serves
 *                                   the EIS_SITE_FILE-selected file).
 *   3. bundled site/site.stub.json — last-resort offline fallback so a plain
 *                                   `vite build` output still demos.
 *
 * Every path is validated with eis-planner's validateSite (throws on schema
 * violations), so consumers always get a typed, coherent SiteModel.
 * ========================================================================== */
import { validateSite } from '@planner/site';
import type { SiteModel } from '@planner/site';
import stubSite from '../../../../site/site.stub.json';
import { isHubMode, hubHttpBase } from '@/dataSource/hubConfig';

/** ARGUS Hub mode: build the SiteModel from the Hub's generated site.geojson + site.json
 *  (Meridian Station) so the mission map, geofence and no-fly zones match the fleet. */
async function siteFromHub(): Promise<SiteModel> {
  const base = hubHttpBase();
  const [geo, site] = await Promise.all([
    fetch(`${base}/console/site.geojson`).then((r) => r.json()),
    fetch(`${base}/console/site.json`).then((r) => r.json()),
  ]);
  type Feature = { properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
  const feats: Feature[] = geo.features;
  const find = (kind: string) => feats.find((f) => f.properties.kind === kind);
  const ring = (f: Feature | undefined): [number, number][] => {
    const coords = (f?.geometry.coordinates as [number, number][][] | undefined)?.[0] ?? [];
    const open = coords.length > 1 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1] ? coords.slice(0, -1) : coords;
    return open.map(([lon, lat]) => [lat, lon]);
  };
  const geofence = find('geofence');
  const noFly = find('no_fly_zone');
  const pad = site.fleet?.[0] ?? { lat: site.anchor.lat, lon: site.anchor.lon };
  const pads = (site.pads ?? []) as { id: string; x: number; y: number }[];
  const padLatLon = (i: number) => site.fleet?.[i] ?? pad;
  return validateSite({
    home: { lat: pad.lat, lon: pad.lon, alt_m: site.anchor?.alt_msl ?? 0 },
    perimeter: ring(geofence),
    nfz: noFly ? [{ name: String(noFly.properties.name ?? 'no-fly'), polygon: ring(noFly), ceiling_m: Number(geofence?.properties.alt_ceiling_m ?? 60) }] : [],
    alt_band_m: { min: Number(geofence?.properties.alt_floor_m ?? 5), max: Number(geofence?.properties.alt_ceiling_m ?? 60) },
    staging: pads.slice(0, site.fleet?.length ?? 0).map((p, i) => ({ id: p.id, lat: padLatLon(i).lat, lon: padLatLon(i).lon, image: 'evidence/overhead/baseline.png', truth: 'false_alarm' })),
  });
}

export type { SiteModel, SiteNfz, SiteStagingPoint, LatLon } from '@planner/site';

let sitePromise: Promise<SiteModel> | null = null;

/**
 * The RAW site JSON the validated model above was built from.
 *
 * `SiteModel` is the planner's slice of the site file — it has no `cameras`,
 * no `no_image_zones` and no `pads`, because the planner does not need them.
 * The cue rails do: `cctv` resolves a camera zone and `fence_sensor` a fence
 * segment against the site's own declarations, and a rail that cannot place
 * its cue would be inventing coordinates. Captured here rather than re-fetched
 * so both views come from ONE load of ONE file (docs/SITE_CONTRACT.md).
 */
let rawSite: unknown = null;

async function resolveSite(): Promise<SiteModel> {
  // 0. ARGUS Hub: the Site the fleet actually flies over.
  if (isHubMode()) {
    try { return await siteFromHub(); } catch (err) { console.warn('[eis-site] ARGUS Hub site failed, falling back:', err); }
  }
  // 1. Electron bridge (present only inside the shells). The shells return the
  //    raw JSON text (site:load reads the file); accept a pre-parsed object too.
  const bridge = typeof window !== 'undefined' ? window.eis?.loadSiteFile : undefined;
  if (bridge) {
    try {
      const raw: unknown = await bridge();
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const model = validateSite(parsed);
      rawSite = parsed;
      return model;
    } catch (err) {
      console.warn('[eis-site] window.eis.loadSiteFile failed, falling back:', err);
    }
  }
  // 2. Dev server route (vite.config.ts siteFilePlugin, EIS_SITE_FILE).
  try {
    const res = await fetch('/site.json');
    if (res.ok) {
      const parsed: unknown = await res.json();
      const model = validateSite(parsed);
      rawSite = parsed;
      return model;
    }
    console.warn(`[eis-site] /site.json responded ${res.status}, falling back to bundled stub`);
  } catch {
    /* offline / file:// — fall through */
  }
  // 3. Bundled stub (still real site-file data, just frozen at build time).
  console.warn('[eis-site] using bundled site/site.stub.json fallback');
  const model = validateSite(stubSite);
  rawSite = stubSite;
  return model;
}

/** Load (once) and memoize the site model. Never rejects twice in a row with
 *  the same cause: a failed load clears the memo so a retry can succeed. */
export function getSiteModel(): Promise<SiteModel> {
  if (!sitePromise) {
    sitePromise = resolveSite().catch((err) => {
      sitePromise = null;
      rawSite = null;
      throw err;
    });
  }
  return sitePromise;
}

/**
 * The raw site JSON behind the loaded model, for consumers that need fields
 * the planner's `SiteModel` does not carry (cameras, fence segments). Null
 * until `getSiteModel()` has resolved — call it first, or `await` it.
 */
export function getRawSite(): unknown {
  return rawSite;
}
