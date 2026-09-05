/* ============================================================================
 * Drone Safety Platform — SHARED CONTRACT (authoritative copy)
 * ----------------------------------------------------------------------------
 * Per the PRD, THIS file (ground/ui/src/contract) is the authoritative shape of
 * the seam between the UI and the live backend. `shared/shared.ts` mirrors it,
 * and `shared/shared.py` is the Python mirror the companion implements.
 *
 * The whole app consumes data ONLY through a `DataSource` obtained from a single
 * `DataSourceContext`. Selecting Mock vs Live is one line in dataSource/index.ts.
 * No `any` anywhere in this file.
 * ========================================================================== */

export type Mode =
  | 'STABILIZE' | 'ALT_HOLD' | 'LOITER' | 'GUIDED'
  | 'AUTO' | 'RTL' | 'LAND' | 'POSHOLD' | 'BRAKE';

export const MODES: Mode[] = [
  'STABILIZE', 'ALT_HOLD', 'LOITER', 'GUIDED', 'AUTO', 'RTL', 'LAND', 'POSHOLD', 'BRAKE',
];

/** Authoritative active control source reported by the vehicle. Exactly one
 *  is ever active (auto guidance, autonomous tracking, manual sticks, or the
 *  mission planner). */
export type ControlSource = 'auto' | 'tracking' | 'manual' | 'planner';

/** Single-vehicle default. Every wire envelope carries an explicit vehicleId
 *  so adding fleet routing later does not require another contract break. */
export const DEFAULT_VEHICLE_ID = 'eis-1' as const;

export type NavSource = 'gps' | 'optflow' | 'extnav';
export type FailsafeState = 'none' | 'hold' | 'rtl' | 'escalate' | 'refuse';

export interface FailsafeStatus {
  state: FailsafeState;
  reason: string;
}

export interface GpsHealth {
  fix: number;
  sats: number;
  hdop: number;
}

export type ChargeState = 'charging' | 'charged' | 'discharging' | 'fault' | 'unknown';

export interface BatteryState {
  soc_pct: number;
  voltage_v: number;
  current_a: number;
  cell_delta_v: number;
  temp_c: number;
  remaining_s: number;
  charge_state: ChargeState;
  fault?: string;
  /** Compatibility aliases used by the existing panels and companion. */
  voltage: number;
  current: number;
  remaining: number;
}

export interface SortieState {
  elapsed_s: number;
  cap_s: number;
  must_rtl_by_s: number;
}

/** Gimbal pitch limits, degrees. -30 looks UP, 0 is level, 90 is straight
 *  DOWN — the same convention the ARGUS console reports (`gimbal_pitch_deg`). */
export const GIMBAL_PITCH_MIN_DEG = -30;
export const GIMBAL_PITCH_MAX_DEG = 90;

/** Reported gimbal attitude. Optional on Telemetry: airframes without a
 *  commandable gimbal omit it rather than reporting a fictional 0. */
export interface GimbalState {
  pitchDeg: number;                 // GIMBAL_PITCH_MIN_DEG..GIMBAL_PITCH_MAX_DEG
}

export interface Telemetry {
  type: 'telemetry';
  ts: number;                       // epoch ms
  vehicleId: string;
  armed: boolean;
  mode: Mode;
  controlSource: ControlSource;     // authoritative active control source
  navSource: NavSource;
  gpsHealth: GpsHealth;
  failsafeState: FailsafeState;
  failsafeReason: string;
  attitude: { roll: number; pitch: number; yaw: number };   // degrees
  position: { lat: number; lon: number; relAlt: number; absAlt: number }; // m
  velocity: { groundspeed: number; verticalSpeed: number }; // m/s
  heading: number;                  // degrees 0..360
  battery: BatteryState;
  /** Compatibility alias for gpsHealth; retained for existing panels. */
  gps: { fixType: number; satellites: number; hdop: number };
  sortie: SortieState | null;
  home: { lat: number; lon: number; distance: number };     // distance m
  link: { rssi: number; latencyMs: number };
  /** Present only when the airframe carries a commandable gimbal. */
  gimbal?: GimbalState;
}

export type TrackingState = 'idle' | 'searching' | 'locked' | 'lost';

export interface DetectedTarget {
  id: number;
  bbox: [number, number, number, number]; // x,y,w,h NORMALISED 0..1 of the video frame
  confidence: number;                      // 0..1
  isLocked: boolean;
}

export interface TrackingStatus {
  type: 'tracking';
  ts: number;
  vehicleId: string;
  state: TrackingState;
  targets: DetectedTarget[];
  lockedTargetId: number | null;
  standoffDistance: number;          // configured target distance, m
  estimatedDistance: number | null;  // estimated current distance to locked target, m
  maxSpeed: number;                  // configured cap, m/s
}

export interface StatusText {
  type: 'statusText';
  ts: number;
  vehicleId: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  text: string;
}

/* ---------------------------------------------------------------------------
 * Mission planner types (anomaly → plan → verification → incident report).
 * ------------------------------------------------------------------------- */

/** Named speed profile for planned missions. */
export type MissionProfile =
  | 'follow' | 'inspect' | 'survey'
  | 'slow' | 'standard' | 'fast';

/** Cruise speed per profile, m/s. These MUST stay under the companion
 *  config.py hard max-speed cap (8 m/s — DEFAULTS.maxSpeedCap). */
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
  /** Existing missionPlan spelling. New planCommand args use alt_m. */
  alt: number;               // m, relative
  alt_m?: number;            // canonical wire alias
  profile?: MissionProfile;  // optional speed override for this leg
  speed_mps?: number;
}

export interface OrbitPointTool {
  tool: 'orbit_point';
  lat: number;
  lon: number;
  radius: number;            // existing missionPlan spelling, m
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
  trackId?: number;          // compatibility alias
}

export interface OrbitTool {
  tool: 'orbit';
  track_id: number;
  profile: MissionProfile;
  trackId?: number;          // compatibility alias
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

/** A detected site anomaly. `type` here is the anomaly KIND (e.g. 'change'),
 *  NOT a message discriminant — the wire wrapper nests the payload precisely
 *  to avoid that collision (see AnomalyMessage). */
export interface Anomaly {
  id: string;
  lat: number;
  lon: number;
  type: string;        // anomaly kind, e.g. 'change'
  confidence: number;  // 0..1
  thumbnail: string;   // repo-relative path or data URL
  source: AnomalySource;
  /** Epoch ms the cue was OBSERVED — earlier than the `ts` of the wire message
   *  that carries it. Optional while the satellite/SAR rails still emit undated
   *  cues; the cue rails (cctv / fence_sensor) always set it. */
  observedAt?: number;
  /** Cue lifetime in seconds measured from `observedAt`. Past it the cue is
   *  stale and must not be dispatched on. Optional for the same reason. */
  ttl_s?: number;
  /** Fixed camera that raised the cue (`site.cameras[].id`), when any. */
  cameraId?: string;
}

/** One decision the planner made, in the order it was made. A trace is a
 *  reason-for-record only: it never carries coordinates, tools or altitudes. */
export interface PlanTraceEntry {
  rule: string;        // the rule that fired, e.g. 'nfz_buffer'
  effect: string;      // what it did, e.g. 'shifted the approach leg outboard'
}

/** One straight segment of the flight tube a verified plan may fly inside. */
export interface CorridorLeg {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  lateral_tol_m: number;   // half-width of the tube about the leg, m
}

/** One orbit the flight tube permits. */
export interface CorridorOrbit {
  center: { lat: number; lon: number };
  radius_m: number;
  radial_tol_m: number;    // permitted radial error about radius_m, m
}

/** The geometric envelope a verified plan is allowed to occupy. The envelope
 *  monitor checks the vehicle against THIS rather than re-running the planner,
 *  so a corridor breach is detectable in one comparison. */
export interface Corridor {
  legs: CorridorLeg[];
  orbits: CorridorOrbit[];
  alt_band_m: { min: number; max: number };  // m AGL, relative to home
  /** `requestId` of the MissionPlan this corridor was generated from. */
  generated_from: string;
}

export interface MissionPlan {
  requestId: string;   // ground-side correlation only — never used by the ack path
  anomalyId: string;
  tools: PlanTool[];
  profile: MissionProfile;
  rationale: string;
  /** Ordered record of the rules that shaped this plan.
   *  Optional for now — the planner does not emit it yet. */
  planTrace?: PlanTraceEntry[];
  /** Flight tube derived from `tools`. Optional for now — same reason. */
  corridor?: Corridor;
}

/** Check names the verifier and the mirrors agree on. `VerificationCheck.name`
 *  stays a plain `string` (the shape is unchanged) so a verifier may still
 *  report a check this list does not know yet.
 *    attended      — the mission's attendance mode permits this dispatch
 *    deconfliction — no other vehicle's corridor conflicts in space and time */
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
   *  dispatched (an attended window that has not opened, a deconfliction wait).
   *  A 'corrected' verdict may carry it with the plan otherwise unchanged. */
  holdUntil?: number;
}

export interface IncidentReport {
  missionId: string;
  verdict: 'false_alarm' | 'log' | 'escalate';
  markdown: string;
}

/* ---------------------------------------------------------------------------
 * Tasking. A task says WHAT to look for and WHY — never where, how high, or
 * with which tool. It carries no coordinates of its own: the only geometry it
 * may reference is `anomalyId`, and turning that into a route is the planner's
 * job (and the verifier's to check). This is exactly the surface an LLM is
 * allowed to emit as schema-bound JSON.
 * ------------------------------------------------------------------------- */
export type TaskLookFor = 'person' | 'vehicle' | 'fence_gap' | 'structure' | 'unknown';
export type TaskUrgency = 'immediate' | 'next_sortie' | 'defer';
export type TaskSource = 'llm' | 'operator' | 'scripted';

/** Hard cap on Task.question so an operator card never has to truncate it. */
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
  assignedTo?: string;  // vehicleId this task is assigned to, if any
}

export interface TaskMessage {
  type: 'task';
  ts: number;
  vehicleId: string;
  task: Task;
}

/* Commands: base PRD §4 set + the manual-piloting extension. High-rate stick
 * input is NOT a command — it goes through setManualInput() and the wire
 * `manualInput` message, which bypasses the ack path.
 *
 * Backend mapping (CODE_PRD §5.2 aliases):
 *   takeManualControl    === engageManual     (acked)
 *   releaseManualControl === disengageManual  (acked)
 *   manualInput          === the manualInput wire message (fire-and-forget) */
export type CommandName =
  | 'arm' | 'disarm' | 'takeoff' | 'land' | 'rtl' | 'setMode'
  | 'engageTracking' | 'disengageTracking' | 'selectTarget'
  | 'setStandoff' | 'setMaxSpeed' | 'emergencyStop'
  | 'engageManual' | 'disengageManual'
  | 'executePlan' | 'abortPlan' | 'continueMission' | 'testFault'
  | 'setGimbal' | 'enterUnattended' | 'exitUnattended';

/** SITL-only fault injection. Companion must reject this command unless both
 *  config.sitl and EIS_ENABLE_TEST_HOOKS=true; it is never an LLM tool. */
export type TestFaultName =
  | 'gps_loss' | 'rf_interference' | 'hostile_drone' | 'link_loss'
  | 'planner_heartbeat' | 'camera' | 'thermal' | 'lidar'
  | 'battery_fault' | 'battery_drain' | 'sortie_expiry' | 'charge'
  | 'wind' | 'raw_out_of_fence';

export interface Command {
  type: 'command';
  vehicleId: string;
  command: CommandName;
  params?: {
    altitude?: number;     // takeoff, m
    mode?: Mode;           // setMode
    targetId?: number;     // selectTarget
    meters?: number;       // setStandoff
    mps?: number;          // setMaxSpeed
    plan?: MissionPlan;    // executePlan: the full verified plan (abortPlan takes no params)
    fault?: TestFaultName; // testFault (SITL + explicit test-hook gate only)
    enabled?: boolean;
    value?: number;
    /** setGimbal, degrees, GIMBAL_PITCH_MIN_DEG..GIMBAL_PITCH_MAX_DEG. */
    pitchDeg?: number;
    /** enterUnattended / exitUnattended: the operator making the change.
     *  Both travel the ordinary acked command path like every other command —
     *  attendance is never changed by a fire-and-forget message. */
    operatorId?: string;
  };
}

/** Acks correlate by command NAME (first-match FIFO) — there is no requestId
 *  on the ack path. The `requestId` inside MissionPlan / Verification exists
 *  for ground-side correlation only and never participates in ack matching. */
export interface CommandAck {
  type: 'ack';
  ts: number;
  vehicleId: string;
  command: CommandName;
  success: boolean;
  message: string;
}

/** High-rate manual stick input. Each axis bipolar, normalised -1..1:
 *   throttle = climb/descend, yaw = yaw rate, pitch = forward/back, roll = left/right. */
export interface ManualInput {
  throttle: number;
  yaw: number;
  pitch: number;
  roll: number;
}

/** On-the-wire manual stick frame (ground -> companion). */
export interface ManualInputMessage extends ManualInput {
  type: 'manualInput';
  ts: number;
  vehicleId: string;
}

/* Planner wire/event messages. Payloads are NESTED (e.g. `anomaly.type` is the
 * anomaly kind) so payload fields never collide with the message `type`
 * discriminant. They flow ground-internally through DataSource today and may
 * later cross the socket unchanged. */
export interface AnomalyMessage {
  type: 'anomaly';
  ts: number;
  vehicleId: string;
  anomaly: Anomaly;
}

export interface MissionPlanMessage {
  type: 'missionPlan';
  ts: number;
  vehicleId: string;
  plan: MissionPlan;
}

export interface VerificationMessage {
  type: 'verification';
  ts: number;
  vehicleId: string;
  verification: Verification;
}

export interface IncidentReportMessage {
  type: 'incidentReport';
  ts: number;
  vehicleId: string;
  report: IncidentReport;
}

/* ---------------------------------------------------------------------------
 * Sensor, RF, health, readiness, fleet, and planner wire messages.
 * New messages are direct envelopes; the four established mission event
 * wrappers above remain nested for backwards compatibility.
 * ------------------------------------------------------------------------- */

export type SensorModality = 'rgb' | 'thermal' | 'lidar' | 'fused';
export type SensorHealth = 'ok' | 'degraded' | 'failed';

export interface ObservationTrack {
  id: number;
  class: string;
  bearing_deg: number;
  range_m: number;
  conf: number;
  modality: SensorModality;
  thermal_delta_c?: number;
}

export interface ObservationGeometry {
  fence_gaps: Array<{ lat: number; lon: number; width_m: number }>;
  new_structures: Array<{ lat: number; lon: number; footprint_m2: number; height_m: number }>;
}

export interface ObservationMessage {
  type: 'observation';
  ts: number;
  vehicleId: string;
  tracks: ObservationTrack[];
  scene: string;
  sensors: { rgb: SensorHealth; thermal: SensorHealth; lidar: SensorHealth };
  geometry: ObservationGeometry;
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

export type PlannerToolName = PlanTool['tool'];

/** Canonical planCommand argument spellings. Published camelCase missionPlan
 *  fields remain accepted above while producers migrate. */
export type PlanCommandArgs =
  | { track_id: number }
  | { dx: number; dy: number; dz: number }
  | { lat: number; lon: number; alt_m: number; speed_mps?: number }
  | { lat: number; lon: number; radius_m: number; laps?: number }
  | { duration_s?: number }
  | Record<string, never>;

export interface PlanCommandMessage {
  type: 'planCommand';
  ts: number;
  vehicleId: string;
  requestId: string;
  tool: PlannerToolName;
  args: PlanCommandArgs;
  profile: MissionProfile;
}

export interface PlanCommandAckMessage {
  type: 'planCommandAck';
  ts: number;
  vehicleId: string;
  requestId: string;
  status: 'accepted' | 'rejected' | 'clamped';
  reason: string;
}

export interface PlanHeartbeatMessage {
  type: 'planHeartbeat';
  ts: number;
  vehicleId: string;
}

export interface ReadinessMessage {
  type: 'readiness';
  ts: number;
  vehicleId: string;
  ready: boolean;
  reasons: string[];
  eta_ready_s: number;
}

export type HealthComponent =
  | 'link' | 'planner' | 'gps' | 'battery' | 'wind' | 'camera'
  | 'thermal' | 'lidar' | 'site_model' | 'mesh' | 'sdr' | 'envelope';

export interface HealthEventMessage {
  type: 'healthEvent';
  ts: number;
  vehicleId: string;
  component: HealthComponent;
  state: string;
  detail: string;
}

export type RfSource = 'sdr' | 'rf_drone';
export type RfEventKind = 'gnss_interference' | 'drone_link' | 'remote_id' | 'hostile_drone';

export interface RfEventMessage {
  type: 'rfEvent';
  ts: number;
  vehicleId: string;
  source: RfSource;
  kind: RfEventKind;
  band: string;
  power_delta_db?: number;
  lat?: number;
  lon?: number;
  pilot_lat?: number;
  pilot_lon?: number;
  confidence: number;
}

export interface SpectrumBand {
  name: string;
  floor_db: number;
  p95_db: number;
  peak_mhz: number;
  occ_bw_mhz: number;
}

export interface SpectrumMessage {
  type: 'spectrum';
  ts: number;
  vehicleId: string;
  bands: SpectrumBand[];
  state: 'warming' | 'nominal' | 'degraded';
}

/* ---------------------------------------------------------------------------
 * Envelope monitoring, attendance mode, escalation, and the cue rails.
 * ------------------------------------------------------------------------- */

export type EnvelopeState = 'in_envelope' | 'warning' | 'breach';

/** Which limit the envelope report is about. Every one of these is a HARD
 *  limit somewhere else in the system; the envelope message reports the
 *  distance to it, it never relaxes it. */
export type EnvelopeConstraint =
  | 'corridor' | 'altitude' | 'geofence' | 'nfz'
  | 'standoff' | 'sortie' | 'separation';

/** What the vehicle did about the constraint. Never 'continue': a breach
 *  resolves to hold | rtl (or an escalation), never to carrying on. */
export type EnvelopeAction = 'none' | 'slow' | 'hold' | 'rtl';

export interface EnvelopeMessage {
  type: 'envelope';
  ts: number;
  vehicleId: string;
  state: EnvelopeState;
  /** The limit this report is about — omitted only when state is
   *  'in_envelope' with nothing notable nearby. */
  constraint?: EnvelopeConstraint;
  /** Signed metres of margin to `constraint`: positive is inside the
   *  envelope, negative is how far past the limit the vehicle is. */
  margin_m?: number;
  action?: EnvelopeAction;
}

/** Whether an operator is on the loop for this vehicle. */
export type AttendanceMode = 'attended' | 'unattended';

export interface ModeMessage {
  type: 'mode';
  ts: number;
  vehicleId: string;
  mode: AttendanceMode;
  since: number;            // epoch ms this attendance mode began
  operatorPresent: boolean; // the liveness signal behind `mode`
}

export interface EscalationMessage {
  type: 'escalation';
  ts: number;
  vehicleId: string;
  missionId: string;
  channel: string;                   // delivery channel id, e.g. 'console'
  /** Channel-specific body, kept verbatim for the audit trail. */
  payload: Record<string, unknown>;
  deliveredAt?: number;              // epoch ms the channel confirmed delivery
}

/** A fixed-camera cue. Audit/provenance ONLY: it records what a camera saw and
 *  when, and never carries a dispatch, a route or an altitude. The dispatchable
 *  form of a camera cue is an `Anomaly` with source 'cctv'. */
export interface CctvEventMessage {
  type: 'cctvEvent';
  ts: number;
  vehicleId: string;
  cameraId: string;    // site.cameras[].id
  zone: string;        // site.cameras[].zones[].name
  class?: string;      // coarse classifier label, when the camera reports one
  thumbnail?: string;  // repo-relative path or data URL
}

/** Sortie budget as the fleet view reports it. Deliberately distinct from
 *  `SortieState`: `must_rtl_by` is an EPOCH-MS deadline, not seconds into the
 *  sortie, so a fleet row is comparable across vehicles that launched at
 *  different times. */
export interface FleetSortie {
  elapsed_s: number;
  must_rtl_by: number;   // epoch ms
}

export interface FleetVehicle {
  vehicleId: string;
  battery: BatteryState;
  controlSource: ControlSource;
  failsafe: FailsafeStatus;
  readiness: Omit<ReadinessMessage, 'type' | 'ts' | 'vehicleId'>;
  position: { lat: number; lon: number; relAlt: number };
  /** The corridor this vehicle is currently cleared to fly, when any — the
   *  input a deconfliction check needs from every other vehicle. */
  plannedCorridor?: Corridor;
  sortie: FleetSortie | null;   // null when the vehicle is not on a sortie
}

export interface FleetMessage {
  type: 'fleet';
  ts: number;
  vehicleId: string;
  vehicles: FleetVehicle[];
}

/** The durable per-mission audit record: everything needed to reconstruct why
 *  a mission flew, what it was allowed to do, and what it actually did.
 *  Carries `vehicleId` like every other audit entry. */
export interface MissionRecord {
  missionId: string;
  vehicleId: string;
  anomalyId: string;
  plan: MissionPlan;
  verification: Verification;
  report?: IncidentReport;
  startedAt: number;
  endedAt?: number;
  /** Attendance mode in force when the mission was dispatched. */
  mode: AttendanceMode;
  /** The task this mission answered, when one drove it (scripted missions
   *  and operator-initiated flights have none). */
  task?: Task;
  /** Planner rule trace; `[]` when the planner did not emit one. */
  planTrace: PlanTraceEntry[];
  /** The corridor the mission was cleared for, when one was generated. */
  corridor?: Corridor;
  /** Every envelope report raised during the mission, in order; `[]` if none. */
  envelopeEvents: EnvelopeMessage[];
  /** vehicleId that handed this mission over, when it was a handoff. */
  handoffFrom?: string;
}

/** Offline demo fault switches. Phase 3 wires these into the new stream
 *  messages; declaring them here keeps the mock control surface stable. */
export interface SimulationToggles {
  simulateGpsLoss: boolean;
  simulateRfInterference: boolean;
  simulateHostileDrone: boolean;
  simulateLinkLoss: boolean;
  simulateCameraFail: boolean;
  simulateCharging: boolean;
  simulateBatteryFault: boolean;
  simulateSortieExpiry: boolean;
  simulateThermalFail: boolean;
  simulateLidarFail: boolean;
  simulateNight: boolean;
}

export type ConnectionState =
  | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionConfig {
  host: string;            // Jetson IP, or 'sitl'
  controlPort: number;     // websocket control/telemetry port, default 8765
  videoUrl: string;        // rtsp/webrtc/http url, or '' for mock
  sitl: boolean;
}

export type InboundMessage =
  | Telemetry | TrackingStatus | StatusText | CommandAck
  | AnomalyMessage | MissionPlanMessage | VerificationMessage | IncidentReportMessage
  | ObservationMessage | CapabilitiesMessage | PlanCommandAckMessage
  | ReadinessMessage | HealthEventMessage | RfEventMessage | SpectrumMessage | FleetMessage
  | TaskMessage | EnvelopeMessage | ModeMessage | EscalationMessage | CctvEventMessage;
export type OutboundMessage =
  | Command | ManualInputMessage | PlanCommandMessage | PlanHeartbeatMessage | RfEventMessage;

export type Unsubscribe = () => void;

export interface DataSource {
  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): void;

  onConnectionChange(cb: (s: ConnectionState) => void): Unsubscribe;
  onTelemetry(cb: (t: Telemetry) => void): Unsubscribe;
  onTracking(cb: (t: TrackingStatus) => void): Unsubscribe;
  onStatusText(cb: (s: StatusText) => void): Unsubscribe;
  onAck(cb: (a: CommandAck) => void): Unsubscribe;

  sendCommand(cmd: Command): Promise<CommandAck>;

  /** High-rate, fire-and-forget manual stick input (see ManualInput). */
  setManualInput(input: ManualInput): void;

  /** RTSP/WebRTC/HTTP URL for the live backend.
   *  MockDataProvider returns '' and the UI renders the mock canvas scene. */
  getVideoUrl(): string;
}

/** Shared connection + tuning defaults (mirror of shared.ts / shared.py). */
export const DEFAULTS = {
  vehicleId: DEFAULT_VEHICLE_ID,
  controlPort: 8765,
  videoPort: 8554,
  standoffDistance: 5,
  minStandoff: 3,
  maxStandoff: 15,
  maxSpeed: 2,
  maxSpeedCap: 8,
  minSpeed: 0.5,
  maxClimbRate: 1.5,
  maxYawRate: 45,
  maxAltitude: 30,
  geofenceRadius: 60,
  manualWatchdogMs: 500,
  groundLinkTimeoutMs: 2000,
  deadzone: 0.09,
} as const;
