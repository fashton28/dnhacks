/* ============================================================================
 * eis-planner — READ-ONLY mirror of the planner slice of the shared contract.
 * ----------------------------------------------------------------------------
 * The AUTHORITATIVE copy is `ground/ui/src/contract/index.ts` (frozen — never
 * edit it, or `shared/shared.ts` / `shared/shared.py`). This package cannot
 * import that file into its build (it compiles standalone to `dist/` for the
 * Node CLI), so the types it needs are mirrored here VERBATIM.
 *
 * Drift protection: `test/contract-parity.test.ts` type-asserts mutual
 * assignability between every type below and the authoritative copy, and
 * deep-equals the PROFILE_SPEED_MPS values at runtime. `npm test` fails if
 * this mirror ever diverges. If the contract changes, update this mirror to
 * match — never the other way around.
 * ========================================================================== */

/** Named speed profile for planned missions. */
export type MissionProfile = 'slow' | 'standard' | 'fast';

/** Cruise speed per profile, m/s. Mirrors the authoritative contract values.
 *  These MUST stay under the companion config.py hard max-speed cap (8 m/s). */
export const PROFILE_SPEED_MPS: Record<MissionProfile, number> = {
  slow: 2.0,
  standard: 4.0,
  fast: 6.0,
};

/* One step of a mission plan, discriminated on `tool`. */
export interface GotoGpsTool {
  tool: 'goto_gps';
  lat: number;
  lon: number;
  alt: number;               // m, relative (AGL)
  profile?: MissionProfile;  // optional speed override for this leg
}

export interface OrbitPointTool {
  tool: 'orbit_point';
  lat: number;
  lon: number;
  radius: number;            // m
}

export interface HoldTool {
  tool: 'hold';
  durationS?: number;        // seconds; omitted = indefinite
}

export interface RtlTool {
  tool: 'rtl';
}

export type PlanTool = GotoGpsTool | OrbitPointTool | HoldTool | RtlTool;

/** A detected site anomaly. `type` is the anomaly KIND (e.g. 'change'). */
export interface Anomaly {
  id: string;
  lat: number;
  lon: number;
  type: string;        // anomaly kind, e.g. 'change'
  confidence: number;  // 0..1
  thumbnail: string;   // repo-relative path or data URL
}

export interface MissionPlan {
  requestId: string;   // ground-side correlation only — never used by the ack path
  anomalyId: string;
  tools: PlanTool[];
  profile: MissionProfile;
  rationale: string;
}

export interface VerificationCheck {
  name: string;
  ok: boolean;
  reason: string;
  edit?: string;       // human-readable description of an applied correction
}

export interface Verification {
  requestId: string;   // matches MissionPlan.requestId (ground-side correlation only)
  verdict: 'pass' | 'corrected' | 'rejected';
  checks: VerificationCheck[];
  correctedPlan?: MissionPlan;  // present when verdict === 'corrected'
}

export interface IncidentReport {
  missionId: string;
  verdict: 'false_alarm' | 'log' | 'escalate';
  markdown: string;
}
