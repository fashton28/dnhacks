/* ============================================================================
 * eis-planner/scripted — deterministic no-network planner.
 *
 * The default demo/test path (EIS_PLANNER_MODE=scripted) uses this planner;
 * the live LLM planner (llm.ts) is only constructed when explicitly enabled.
 *
 * ALL coordinates are DERIVED from the loaded site model + anomaly — nothing
 * is hardcoded, so a different site JSON produces different plans.
 * ========================================================================== */

import { Anomaly, MissionPlan } from './contract';
import { LatLon, SiteModel, haversineMeters, polygonCentroid } from './site';

/** Orbit radius used by the passing plan, meters (well above the 3 m floor). */
export const ORBIT_RADIUS_M = 25;
/** The scripted plan uses the inspect/standard profile, whose fixture cap is 45 m AGL. */
export const SCRIPTED_PROFILE_MAX_ALT_M = 45;

/** How far above the alt band's max the failing plan flies, meters. */
export const FAILING_ALT_OVERSHOOT_M = 10;

/** How far below the alt band's min the failing plan flies when the first
 *  NFZ's ceiling is inside the band (so an above-band altitude could not also
 *  violate the NFZ), meters. */
export const FAILING_ALT_UNDERSHOOT_M = 5;

/** Point on the observation ring facing home, so approach never breaches standoff. */
export function orbitApproachPoint(home: LatLon, center: LatLon, radiusM: number): LatLon {
  const distance = haversineMeters(home, center);
  if (distance < 0.01) return { lat: center.lat + radiusM / 111_320, lon: center.lon };
  const scale = radiusM / distance;
  return { lat: center.lat + (home.lat - center.lat) * scale,
    lon: center.lon + (home.lon - center.lon) * scale };
}

export class ScriptedPlanner {
  /**
   * Emit a plan for the anomaly. `failing: true` returns the deliberately
   * invalid demo plan (see failingPlan), otherwise the passing plan.
   */
  plan(site: SiteModel, anomaly: Anomaly, opts: { failing?: boolean } = {}): MissionPlan {
    return opts.failing ? this.failingPlan(site, anomaly) : this.passingPlan(site, anomaly);
  }

  /**
   * A plan the verifier should PASS: goto the anomaly location at the middle
   * of the site alt band with profile 'standard', orbit it at ORBIT_RADIUS_M,
   * then RTL. (Assumes the anomaly lies inside the perimeter and outside any
   * NFZ — a mid-site anomaly; otherwise the verifier corrects/rejects it,
   * which is the verifier's job, not this planner's.)
   */
  passingPlan(site: SiteModel, anomaly: Anomaly): MissionPlan {
    const midAlt = Math.min(
      (site.altBandM.min + site.altBandM.max) / 2,
      SCRIPTED_PROFILE_MAX_ALT_M,
    );
    const approach = orbitApproachPoint(site.home, anomaly, ORBIT_RADIUS_M);
    return {
      requestId: `scripted-${anomaly.id}`,
      anomalyId: anomaly.id,
      profile: 'standard',
      rationale:
        `Scripted survey of anomaly ${anomaly.id} (${anomaly.type}, ` +
        `confidence ${anomaly.confidence}): fly to the flagged location at ` +
        `mid-band altitude ${midAlt} m AGL, orbit at ${ORBIT_RADIUS_M} m for ` +
        `observation, then return to launch.`,
      tools: [
        { tool: 'goto_gps', lat: approach.lat, lon: approach.lon, alt: midAlt, profile: 'standard' },
        { tool: 'orbit_point', lat: anomaly.lat, lon: anomaly.lon, radius: ORBIT_RADIUS_M },
        { tool: 'rtl' },
      ],
    };
  }

  /**
   * A plan the verifier must FAIL on BOTH the nfz and altitude checks (per
   * spec): a goto straight into the site's first NFZ at an altitude that is
   * outside the alt band yet still at/below the NFZ ceiling.
   *
   * Altitude choice, derived from the site:
   *  - preferred: alt_band.max + FAILING_ALT_OVERSHOOT_M (above the band),
   *    capped at the NFZ ceiling so the NFZ check also fails;
   *  - if the ceiling is not above the band max (an above-band altitude
   *    could never be inside the NFZ), fly BELOW the band instead:
   *    max(1, alt_band.min - FAILING_ALT_UNDERSHOOT_M), capped at the ceiling.
   *
   * Throws if the site declares no NFZs (there is nothing to violate).
   */
  failingPlan(site: SiteModel, anomaly: Anomaly): MissionPlan {
    if (site.nfz.length === 0) {
      throw new Error('ScriptedPlanner.failingPlan: site has no NFZs to violate');
    }
    const zone = site.nfz[0];
    const target = polygonCentroid(zone.polygon);
    const band = site.altBandM;

    let alt: number;
    if (zone.ceilingM > band.max) {
      alt = Math.min(zone.ceilingM, band.max + FAILING_ALT_OVERSHOOT_M);
    } else {
      alt = Math.min(zone.ceilingM, Math.max(1, band.min - FAILING_ALT_UNDERSHOOT_M));
    }

    return {
      requestId: `scripted-failing-${anomaly.id}`,
      anomalyId: anomaly.id,
      profile: 'standard',
      rationale:
        `Deliberately invalid demo plan for anomaly ${anomaly.id}: flies into ` +
        `NFZ "${zone.name}" at ${alt} m AGL, which is both inside the no-fly ` +
        `ceiling (${zone.ceilingM} m) and outside the site alt band ` +
        `[${band.min}, ${band.max}] m. The MissionVerifier must flag it.`,
      tools: [
        { tool: 'goto_gps', lat: target.lat, lon: target.lon, alt, profile: 'standard' },
        { tool: 'rtl' },
      ],
    };
  }
}
