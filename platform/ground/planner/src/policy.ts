import { MissionProfile } from './contract';

/**
 * Generated mirror of verifier_fixtures/profiles.json and range_model.json.
 * test/policy-parity.test.ts prevents drift from the reviewable source files.
 */
export const VERIFIER_POLICY = {
  hardMinStandoffM: 3,
  hardMaxSpeedMps: 8,
  nominalEnduranceS: 1500,
  reservePct: 25,
  windTimeFactorPerMps: 0.05,
  maxWindMps: 12,
  anomalyProximityM: 200,
  maxSortieS: 480,
  dispatchMinSocPct: 80,
  cellImbalanceMaxV: 0.1,
  battTempMaxC: 60,
} as const;

export const PROFILE_POLICY: Record<MissionProfile, {
  maxSpeedMps: number;
  maxAltitudeM: number;
  standoffM: number;
  maxSortieS: number;
}> = {
  follow: { maxSpeedMps: 2, maxAltitudeM: 50, standoffM: 8, maxSortieS: 480 },
  inspect: { maxSpeedMps: 4, maxAltitudeM: 45, standoffM: 5, maxSortieS: 480 },
  survey: { maxSpeedMps: 6, maxAltitudeM: 60, standoffM: 8, maxSortieS: 480 },
  slow: { maxSpeedMps: 2, maxAltitudeM: 50, standoffM: 8, maxSortieS: 480 },
  standard: { maxSpeedMps: 4, maxAltitudeM: 45, standoffM: 5, maxSortieS: 480 },
  fast: { maxSpeedMps: 6, maxAltitudeM: 60, standoffM: 8, maxSortieS: 480 },
};

/**
 * RF freshness. An RF report is a statement about the airspace AT A MOMENT;
 * `rf_adapter.CORRELATION_WINDOW_MS` already treats 60 s as the window inside
 * which an RF hit and a GPS loss are the same event, and `docs/FAILURE_MODES.md`
 * §2 states the interference response against that same live window. The
 * verifier uses it too, so one hostile-drone report at the top of the session
 * cannot refuse every mission for the rest of it (FM-51).
 *
 * Absent a `now`, the verifier reads events as current: a caller that cannot
 * say what time it is gets the pessimistic (all events live) reading, exactly
 * as `fleetTs` gets the optimistic one for separation.
 */
export const RF_POLICY = {
  /** Seconds an RF event stays part of the current airspace picture. */
  eventWindowS: 60,
  /**
   * SDR front-end states that can support the assertion "no blocking RF
   * interference". A saturated or degraded receiver cannot see interference it
   * is blind to, so it is reported as UNKNOWN, never as clear (FM-50).
   */
  trustedSdrStates: ['nominal'] as const,
  /** States that mean "the receiver is there but cannot be believed". */
  impairedSdrStates: ['warming', 'degraded', 'saturated'] as const,
} as const;

/**
 * Observation accuracy (FM-73). `VERIFIER_POLICY.anomalyProximityM` is the
 * OUTER bound: some target in the mission has to be near the cue at all. It is
 * far too loose for an observation point, because an orbit centre 150 m from
 * the cue produces a mission that flies, orbits, sees nothing relevant, and
 * reports the result as the cue's location.
 *
 * `orbitCentreToleranceM` is what an observation-class tool must hold. The
 * deterministic planner puts an orbit centre EXACTLY on the cue (rounded to
 * 6 dp ≈ 0.11 m), and the only legal displacement is a verifier correction
 * pushing the centre clear of a buffered NFZ or the geofence — bounded by the
 * fixture site's 25 m NFZ buffer plus the 5 m correction margin, doubled for
 * a corner case where both corrections apply. Anything further away is not an
 * observation of this cue and is refused rather than quietly corrected.
 */
export const OBSERVATION_POLICY = {
  orbitCentreToleranceM: 60,
} as const;

/** Compatibility profile names resolve to the canonical three (ADR D13). */
export const PROFILE_ALIASES: Record<MissionProfile, 'follow' | 'inspect' | 'survey'> = {
  follow: 'follow', inspect: 'inspect', survey: 'survey',
  slow: 'follow', standard: 'inspect', fast: 'survey',
};

/** Resolve `standard` → `inspect`, `fast` → `survey`, `slow` → `follow`. */
export function canonicalProfile(profile: MissionProfile): 'follow' | 'inspect' | 'survey' {
  return PROFILE_ALIASES[profile];
}

/**
 * `UNATTENDED_ENVELOPE` — the shared policy module the verifier's `attended`
 * check and the deterministic planner both read (ADR D23, docs/CONOPS.md §2).
 *
 * Every value here TIGHTENS a limit that already exists somewhere else; none
 * relaxes one:
 *
 *  - `maxWindMps` 6 is exactly half the attended 12 m/s in
 *    `verifier_fixtures/range_model.json` (`VERIFIER_POLICY.maxWindMps`).
 *  - `altBandM` 30–50 is a strict subset of the 20–80 m site band in
 *    `docs/SITE_CONTRACT.md`, with margin at both edges.
 *  - `profile` `inspect` is one of the three canonical profiles in
 *    `verifier_fixtures/profiles.json`; its own caps still apply on top.
 *  - `maxHoldS` 15 matches `PLANNER_POLICY.fenceGapHoldS`, the deterministic
 *    planner's only hold case, and is well under the verifier's 60 s bound.
 *  - `maxLaps` 1 matches `PLANNER_POLICY.laps`.
 *  - `maxSortiesPerHour` 2 is the cue-flooding bound from
 *    `docs/THREAT_MODEL.md` § A6.1.
 *
 * The companion's `config.py` carries the hard floors these sit above
 * (3 m standoff, 8 m/s, `max_sortie_s`, `dispatch_min_soc_pct`) but has no
 * `UNATTENDED_ENVELOPE` constant yet. When it grows one it must mirror this
 * table exactly, the way `policy.ts` mirrors `profiles.json`, and
 * `test/policy-parity.test.ts` should grow the corresponding assertion. YAML,
 * env and profile overrides may TIGHTEN any of these; nothing may relax them.
 */
export const UNATTENDED_ENVELOPE = {
  /** Containment: nothing leaves the site perimeter unsupervised. */
  containment: 'perimeter' as const,
  /** The only profile flown unattended; survey deserves an operator. */
  profile: 'inspect' as const,
  /** Metres AGL, a subset of the 20–80 m site band with margin at both edges. */
  altBandM: { min: 30, max: 50 },
  /** Bounded and predictable: no adaptive loiter. */
  maxLaps: 1,
  /** Seconds; matches the planner's only hold case (`fence_gap`). */
  maxHoldS: 15,
  /** Unattended sorties per trailing hour — bounds cue flooding (A6.1). */
  maxSortiesPerHour: 2,
  /** Half the attended 12 m/s limit: nobody can take manual control. */
  maxWindMps: 6,
} as const;

/**
 * Corridor tolerances (ADR D21). The corridor — not the waypoint list — is
 * what the monitor checks.
 */
export const CORRIDOR_POLICY = {
  lateralTolInspectM: 10,
  lateralTolSurveyM: 15,
  radialTolM: 5,
} as const;

/** Inter-vehicle separation policy (ADR D21 / D26). */
export const DECONFLICTION_POLICY = {
  /** Nominal lateral separation between corridors, metres. */
  minSeparationM: 40,
  /** Separation required when peer data is older than `stalePeerS`, metres. */
  staleSeparationM: 80,
  /** Peer-data age past which separation doubles, seconds. */
  stalePeerS: 3,
  /** Peer-data age past which the honest answer is to stop moving, seconds. */
  holdPeerS: 10,
  /** Vertical stagger that clears a crossing corridor, metres. */
  altitudeStaggerM: 10,
  /** Orbit centres closer than this are the SAME centre; never shared. */
  sharedOrbitCentreM: 10,
  /** Margin added to a peer's `must_rtl_by` for a delayed dispatch, seconds. */
  dispatchDelayMarginS: 30,
} as const;

/**
 * Deterministic-planner shape policy (ADR D20). Orbit radii are the REQUESTED
 * radius; geometry shrinks them to clear NFZs and the geofence and never below
 * the profile standoff floor in `PROFILE_POLICY`.
 */
export const PLANNER_POLICY = {
  orbitRadiusM: {
    follow: 15, inspect: 25, survey: 40,
    slow: 15, standard: 25, fast: 40,
  } as Record<MissionProfile, number>,
  /** Exactly one lap, always. */
  laps: 1,
  /** Seconds, and only for `fence_gap`. */
  fenceGapHoldS: 15,
} as const;
