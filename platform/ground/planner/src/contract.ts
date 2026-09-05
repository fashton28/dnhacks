/* ============================================================================
 * eis-planner — standalone mirror of the planner slice of the shared contract.
 * ----------------------------------------------------------------------------
 * The AUTHORITATIVE copy is `ground/ui/src/contract/index.ts`. This package cannot
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
export const DEFAULT_VEHICLE_ID = 'eis-1' as const;

export type MissionProfile =
  | 'follow' | 'inspect' | 'survey'
  | 'slow' | 'standard' | 'fast';

/** Cruise speed per profile, m/s. Mirrors the authoritative contract values.
 *  These MUST stay under the companion config.py hard max-speed cap (8 m/s). */
export const PROFILE_SPEED_MPS: Record<MissionProfile, number> = {
  follow: 2.0,
  inspect: 4.0,
  survey: 6.0,
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
  alt_m?: number;            // canonical wire alias
  profile?: MissionProfile;  // optional speed override for this leg
  speed_mps?: number;
}

export interface OrbitPointTool {
  tool: 'orbit_point';
  lat: number;
  lon: number;
  radius: number;            // m
  radius_m?: number;         // canonical wire alias
  laps?: number;
}

export interface HoldTool {
  tool: 'hold';
  durationS?: number;        // seconds; omitted = indefinite
  duration_s?: number;       // canonical wire alias
}

export interface RtlTool {
  tool: 'rtl';
}

export interface FollowTool {
  tool: 'follow';
  track_id: number;
  profile: MissionProfile;
  trackId?: number;
}

export interface OrbitTool {
  tool: 'orbit';
  track_id: number;
  profile: MissionProfile;
  trackId?: number;
}

export interface GotoRelativeTool {
  tool: 'goto_relative';
  dx: number;
  dy: number;
  dz: number;
}

export type PlanTool =
  | FollowTool | OrbitTool | GotoRelativeTool
  | GotoGpsTool | OrbitPointTool | HoldTool | RtlTool;

/** Where a cue came from. `cctv` and `fence_sensor` are the fixed-infrastructure
 *  "cue rails": they observe continuously and their cues expire (see `ttl_s`). */
export type AnomalySource =
  | 'sentinel2' | 'sar' | 'sdr' | 'rf_drone' | 'drone_survey'
  | 'cctv' | 'fence_sensor';

/** A detected site anomaly. `type` is the anomaly KIND (e.g. 'change'). */
export interface Anomaly {
  id: string;
  lat: number;
  lon: number;
  type: string;        // anomaly kind, e.g. 'change'
  confidence: number;  // 0..1
  thumbnail: string;   // repo-relative path or data URL
  source: AnomalySource;
  /** Epoch ms the cue was OBSERVED. Optional while the satellite/SAR rails
   *  still emit undated cues; the cue rails always set it. */
  observedAt?: number;
  /** Cue lifetime in seconds from `observedAt`; past it the cue is stale. */
  ttl_s?: number;
  /** Fixed camera that raised the cue (`site.cameras[].id`), when any. */
  cameraId?: string;
}

/** One decision the planner made, in the order it was made. Reason-for-record
 *  only: never coordinates, tools or altitudes. */
export interface PlanTraceEntry { rule: string; effect: string; }

export interface CorridorLeg {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  lateral_tol_m: number;
}

export interface CorridorOrbit {
  center: { lat: number; lon: number };
  radius_m: number;
  radial_tol_m: number;
}

/** The geometric envelope a verified plan is allowed to occupy. */
export interface Corridor {
  legs: CorridorLeg[];
  orbits: CorridorOrbit[];
  alt_band_m: { min: number; max: number };  // m AGL, relative to home
  generated_from: string;                    // MissionPlan.requestId
}

export interface MissionPlan {
  requestId: string;   // ground-side correlation only — never used by the ack path
  anomalyId: string;
  tools: PlanTool[];
  profile: MissionProfile;
  rationale: string;
  /** Optional for now — the planner does not emit these yet. */
  planTrace?: PlanTraceEntry[];
  corridor?: Corridor;
}

/** Check names the verifier and the mirrors agree on. `VerificationCheck.name`
 *  stays a plain `string` so a verifier may report an unlisted check. */
export type VerificationCheckName =
  | 'geofence' | 'nfz' | 'altitude' | 'battery' | 'attended' | 'deconfliction';

export const VERIFICATION_CHECK_NAMES: VerificationCheckName[] = [
  'geofence', 'nfz', 'altitude', 'battery', 'attended', 'deconfliction',
];

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
  /** Delayed-dispatch correction: epoch ms before which this plan must NOT be
   *  dispatched (an attended window that has not opened, a deconfliction wait). */
  holdUntil?: number;
}

export interface IncidentReport {
  missionId: string;
  verdict: 'false_alarm' | 'log' | 'escalate';
  markdown: string;
}

/* ---- Tasking: WHAT to look for and WHY. No coordinates (only anomalyId),
 * no tools, no altitudes — the schema-bound surface an LLM may emit. ------ */
export type TaskLookFor = 'person' | 'vehicle' | 'fence_gap' | 'structure' | 'unknown';
export type TaskUrgency = 'immediate' | 'next_sortie' | 'defer';
export type TaskSource = 'llm' | 'operator' | 'scripted';

export const TASK_QUESTION_MAX_CHARS = 120;

export interface Task {
  taskId: string;
  anomalyId: string;
  lookFor: TaskLookFor;
  question: string;     // <= TASK_QUESTION_MAX_CHARS characters
  urgency: TaskUrgency;
  priority: number;     // 0..1
  rationale: string;
  source: TaskSource;
  assignedTo?: string;  // vehicleId
}

export interface TaskMessage {
  type: 'task';
  ts: number;
  vehicleId: string;
  task: Task;
}

export type NavSource = 'gps' | 'optflow' | 'extnav';
export type FailsafeState = 'none' | 'hold' | 'rtl' | 'escalate' | 'refuse';
export type ChargeState = 'charging' | 'charged' | 'discharging' | 'fault' | 'unknown';
export type SensorModality = 'rgb' | 'thermal' | 'lidar' | 'fused';
export type SensorHealth = 'ok' | 'degraded' | 'failed';
export type ControlSource = 'auto' | 'tracking' | 'manual' | 'planner';
export type Mode =
  | 'STABILIZE' | 'ALT_HOLD' | 'LOITER' | 'GUIDED'
  | 'AUTO' | 'RTL' | 'LAND' | 'POSHOLD' | 'BRAKE';

export interface FailsafeStatus { state: FailsafeState; reason: string; }
export interface GpsHealth { fix: number; sats: number; hdop: number; }
export interface SortieState { elapsed_s: number; cap_s: number; must_rtl_by_s: number; }

/** Gimbal pitch limits, degrees: -30 up, 0 level, 90 straight down. */
export const GIMBAL_PITCH_MIN_DEG = -30;
export const GIMBAL_PITCH_MAX_DEG = 90;
export interface GimbalState { pitchDeg: number; }

export interface BatteryState {
  soc_pct: number;
  voltage_v: number;
  current_a: number;
  cell_delta_v: number;
  temp_c: number;
  remaining_s: number;
  charge_state: ChargeState;
  fault?: string;
  voltage: number;
  current: number;
  remaining: number;
}

export interface Telemetry {
  type: 'telemetry';
  ts: number;
  vehicleId: string;
  armed: boolean;
  mode: Mode;
  controlSource: ControlSource;
  navSource: NavSource;
  gpsHealth: GpsHealth;
  failsafeState: FailsafeState;
  failsafeReason: string;
  attitude: { roll: number; pitch: number; yaw: number };
  position: { lat: number; lon: number; relAlt: number; absAlt: number };
  velocity: { groundspeed: number; verticalSpeed: number };
  heading: number;
  battery: BatteryState;
  gps: { fixType: number; satellites: number; hdop: number };
  sortie: SortieState | null;
  home: { lat: number; lon: number; distance: number };
  link: { rssi: number; latencyMs: number };
  /** Present only when the airframe carries a commandable gimbal. */
  gimbal?: GimbalState;
}

export interface ReadinessMessage {
  type: 'readiness';
  ts: number;
  vehicleId: string;
  ready: boolean;
  reasons: string[];
  eta_ready_s: number;
}

export interface ObservationTrack {
  id: number;
  class: string;
  bearing_deg: number;
  range_m: number;
  conf: number;
  modality: SensorModality;
  thermal_delta_c?: number;
}

export interface ObservationMessage {
  type: 'observation';
  ts: number;
  vehicleId: string;
  tracks: ObservationTrack[];
  scene: string;
  sensors: { rgb: SensorHealth; thermal: SensorHealth; lidar: SensorHealth };
  geometry: {
    fence_gaps: Array<{ lat: number; lon: number; width_m: number }>;
    new_structures: Array<{ lat: number; lon: number; footprint_m2: number; height_m: number }>;
  };
  /** Data URL or repo-relative staged-image path for recognizer/UI use. */
  frames?: { rgb?: string; thermal?: string };
  missionId?: string;
  stagingId?: string;
}

export interface CapabilityProfile {
  profile: MissionProfile;
  min_standoff_m: number;
  max_standoff_m: number;
  max_speed_mps: number;
  max_altitude_m: number;
}

export interface CapabilitiesMessage {
  type: 'capabilities';
  ts: number;
  vehicleId: string;
  profiles: CapabilityProfile[];
  sensors: SensorModality[];
  night_capable: boolean;
  max_sortie_s: number;
  dispatch_min_soc_pct: number;
}

export type RfEventKind = 'gnss_interference' | 'drone_link' | 'remote_id' | 'hostile_drone';
export interface RfEventMessage {
  type: 'rfEvent';
  ts: number;
  vehicleId: string;
  source: 'sdr' | 'rf_drone';
  kind: RfEventKind;
  band: string;
  power_delta_db?: number;
  lat?: number;
  lon?: number;
  pilot_lat?: number;
  pilot_lon?: number;
  confidence: number;
}

export type HealthComponent =
  | 'link' | 'planner' | 'gps' | 'battery' | 'wind' | 'camera'
  | 'thermal' | 'lidar' | 'site_model' | 'mesh' | 'sdr' | 'envelope';
export interface HealthEventMessage {
  type: 'healthEvent'; ts: number; vehicleId: string;
  component: HealthComponent; state: string; detail: string;
}
export interface SpectrumBand {
  name: string; floor_db: number; p95_db: number; peak_mhz: number; occ_bw_mhz: number;
}
export interface SpectrumMessage {
  type: 'spectrum'; ts: number; vehicleId: string; bands: SpectrumBand[];
  state: 'warming' | 'nominal' | 'degraded';
}
export type PlannerToolName = PlanTool['tool'];
export type PlanCommandArgs =
  | { track_id: number } | { dx: number; dy: number; dz: number }
  | { lat: number; lon: number; alt_m: number; speed_mps?: number }
  | { lat: number; lon: number; radius_m: number; laps?: number }
  | { duration_s?: number } | Record<string, never>;
export interface PlanCommandMessage {
  type: 'planCommand'; ts: number; vehicleId: string; requestId: string;
  tool: PlannerToolName; args: PlanCommandArgs; profile: MissionProfile;
}
export interface PlanCommandAckMessage {
  type: 'planCommandAck'; ts: number; vehicleId: string; requestId: string;
  status: 'accepted' | 'rejected' | 'clamped'; reason: string;
}
export interface PlanHeartbeatMessage { type: 'planHeartbeat'; ts: number; vehicleId: string; }

/* ---- Envelope monitoring, attendance mode, escalation, cue rails ---------- */
export type EnvelopeState = 'in_envelope' | 'warning' | 'breach';
export type EnvelopeConstraint =
  | 'corridor' | 'altitude' | 'geofence' | 'nfz'
  | 'standoff' | 'sortie' | 'separation';
/** Never 'continue': a breach resolves to hold | rtl (or an escalation). */
export type EnvelopeAction = 'none' | 'slow' | 'hold' | 'rtl';
export interface EnvelopeMessage {
  type: 'envelope'; ts: number; vehicleId: string; state: EnvelopeState;
  constraint?: EnvelopeConstraint;
  /** Signed metres to `constraint`; negative is past the limit. */
  margin_m?: number;
  action?: EnvelopeAction;
}
export type AttendanceMode = 'attended' | 'unattended';
export interface ModeMessage {
  type: 'mode'; ts: number; vehicleId: string; mode: AttendanceMode;
  since: number; operatorPresent: boolean;
}
export interface EscalationMessage {
  type: 'escalation'; ts: number; vehicleId: string; missionId: string;
  channel: string; payload: Record<string, unknown>; deliveredAt?: number;
}
/** Audit/provenance only — never a dispatch, a route or an altitude. */
export interface CctvEventMessage {
  type: 'cctvEvent'; ts: number; vehicleId: string;
  cameraId: string; zone: string; class?: string; thumbnail?: string;
}

/** `must_rtl_by` is an EPOCH-MS deadline, unlike SortieState.must_rtl_by_s. */
export interface FleetSortie { elapsed_s: number; must_rtl_by: number; }
export interface FleetVehicle {
  vehicleId: string; battery: BatteryState; controlSource: ControlSource; failsafe: FailsafeStatus;
  readiness: Omit<ReadinessMessage, 'type' | 'ts' | 'vehicleId'>;
  position: { lat: number; lon: number; relAlt: number };
  plannedCorridor?: Corridor;
  sortie: FleetSortie | null;
}
export interface FleetMessage { type: 'fleet'; ts: number; vehicleId: string; vehicles: FleetVehicle[]; }

/** The durable per-mission audit record; carries vehicleId like every entry. */
export interface MissionRecord {
  missionId: string;
  vehicleId: string;
  anomalyId: string;
  plan: MissionPlan;
  verification: Verification;
  report?: IncidentReport;
  startedAt: number;
  endedAt?: number;
  mode: AttendanceMode;
  task?: Task;
  planTrace: PlanTraceEntry[];
  corridor?: Corridor;
  envelopeEvents: EnvelopeMessage[];
  handoffFrom?: string;
}
export interface SimulationToggles {
  simulateGpsLoss: boolean; simulateRfInterference: boolean; simulateHostileDrone: boolean;
  simulateLinkLoss: boolean; simulateCameraFail: boolean; simulateCharging: boolean;
  simulateBatteryFault: boolean; simulateSortieExpiry: boolean; simulateThermalFail: boolean;
  simulateLidarFail: boolean; simulateNight: boolean;
}
