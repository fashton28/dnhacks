/* ============================================================================
 * Eye in the Sky — site provider (renderer side).
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

export type { SiteModel, SiteNfz, SiteStagingPoint, LatLon } from '@planner/site';

let sitePromise: Promise<SiteModel> | null = null;

async function resolveSite(): Promise<SiteModel> {
  // 1. Electron bridge (present only inside the shells). The shells return the
  //    raw JSON text (site:load reads the file); accept a pre-parsed object too.
  const bridge = typeof window !== 'undefined' ? window.eis?.loadSiteFile : undefined;
  if (bridge) {
    try {
      const raw: unknown = await bridge();
      return validateSite(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch (err) {
      console.warn('[eis-site] window.eis.loadSiteFile failed, falling back:', err);
    }
  }
  // 2. Dev server route (vite.config.ts siteFilePlugin, EIS_SITE_FILE).
  try {
    const res = await fetch('/site.json');
    if (res.ok) return validateSite(await res.json());
    console.warn(`[eis-site] /site.json responded ${res.status}, falling back to bundled stub`);
  } catch {
    /* offline / file:// — fall through */
  }
  // 3. Bundled stub (still real site-file data, just frozen at build time).
  console.warn('[eis-site] using bundled site/site.stub.json fallback');
  return validateSite(stubSite);
}

/** Load (once) and memoize the site model. Never rejects twice in a row with
 *  the same cause: a failed load clears the memo so a retry can succeed. */
export function getSiteModel(): Promise<SiteModel> {
  if (!sitePromise) {
    sitePromise = resolveSite().catch((err) => {
      sitePromise = null;
      throw err;
    });
  }
  return sitePromise;
}
