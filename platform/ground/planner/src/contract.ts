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

export type AnomalySource =
  | 'sentinel2' | 'sar' | 'sdr' | 'rf_drone' | 'drone_survey' | 'cctv';

/** A detected site anomaly. `type` is the anomaly KIND (e.g. 'change'). */
export interface Anomaly {
  id: string;
  lat: number;
  lon: number;
  type: string;        // anomaly kind, e.g. 'change'
  confidence: number;  // 0..1
  thumbnail: string;   // repo-relative path or data URL
  source: AnomalySource;
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
  | 'thermal' | 'lidar' | 'site_model' | 'mesh' | 'sdr';
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
export interface FleetVehicle {
  vehicleId: string; battery: BatteryState; controlSource: ControlSource; failsafe: FailsafeStatus;
  readiness: Omit<ReadinessMessage, 'type' | 'ts' | 'vehicleId'>;
}
export interface FleetMessage { type: 'fleet'; ts: number; vehicleId: string; vehicles: FleetVehicle[]; }
export interface SimulationToggles {
  simulateGpsLoss: boolean; simulateRfInterference: boolean; simulateHostileDrone: boolean;
  simulateLinkLoss: boolean; simulateCameraFail: boolean; simulateCharging: boolean;
  simulateBatteryFault: boolean; simulateSortieExpiry: boolean; simulateThermalFail: boolean;
  simulateLidarFail: boolean; simulateNight: boolean;
}
