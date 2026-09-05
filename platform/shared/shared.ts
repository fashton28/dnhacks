/* ============================================================================
 * Drone Safety Platform — SHARED CONTRACT (TypeScript)
 * ----------------------------------------------------------------------------
 * The single source of truth for the seam between the ground control center
 * (ground/ui + ground/app) and the Jetson companion (companion/*).
 *
 * This file is kept byte-for-byte semantically in sync with `shared/shared.py`.
 * The UI's generated copy lives at `ground/ui/src/contract/index.ts` and is the
 * AUTHORITATIVE shape; this file mirrors it. If they ever diverge, conform both
 * to the UI's contract.
 *
 * Wire transport (PRD §5.1):
 *   - Control + telemetry: a WebSocket (default port 8765), JSON messages.
 *     companion -> ground:  telemetry (~10 Hz), tracking (~10 Hz), statusText, ack
 *     ground -> companion:  command, manualInput
 *   - manualInput is HIGH-RATE and FIRE-AND-FORGET (never acked per frame).
 *     Only engageManual / disengageManual (and every other command) are acked.
 *   - Video: RTSP or WebRTC from the Jetson (default rtsp://<host>:8554/stream).
 * ========================================================================== */

export type Mode =
  | 'STABILIZE' | 'ALT_HOLD' | 'LOITER' | 'GUIDED'
  | 'AUTO' | 'RTL' | 'LAND' | 'POSHOLD' | 'BRAKE';

/** Authoritative active control source, reported by the vehicle. Exactly one is
 *  ever active. The UI may also track manual state locally for instant feedback. */
export type ControlSource = 'auto' | 'tracking' | 'manual' | 'planner';

export const DEFAULT_VEHICLE_ID = 'eis-1' as const;
export type NavSource = 'gps' | 'optflow' | 'extnav';
export type FailsafeState = 'none' | 'hold' | 'rtl' | 'escalate' | 'refuse';
export interface FailsafeStatus { state: FailsafeState; reason: string; }
export interface GpsHealth { fix: number; sats: number; hdop: number; }
export type ChargeState = 'charging' | 'charged' | 'discharging' | 'fault' | 'unknown';
export interface BatteryState {
  soc_pct: number; voltage_v: number; current_a: number; cell_delta_v: number;
  temp_c: number; remaining_s: number; charge_state: ChargeState; fault?: string;
  voltage: number; current: number; remaining: number;
}
export interface SortieState { elapsed_s: number; cap_s: number; must_rtl_by_s: number; }

export interface Telemetry {
  type: 'telemetry';
  ts: number;                       // epoch ms
  vehicleId: string;
  armed: boolean;
  mode: Mode;
  controlSource: ControlSource;
  navSource: NavSource;
  gpsHealth: GpsHealth;
  failsafeState: FailsafeState;
  failsafeReason: string;
  attitude: { roll: number; pitch: number; yaw: number };   // degrees
  position: { lat: number; lon: number; relAlt: number; absAlt: number }; // m
  velocity: { groundspeed: number; verticalSpeed: number }; // m/s
  heading: number;                  // degrees 0..360
  battery: BatteryState;
  gps: { fixType: number; satellites: number; hdop: number };
  sortie: SortieState | null;
  home: { lat: number; lon: number; distance: number };     // distance m
  link: { rssi: number; latencyMs: number };
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
export type MissionProfile = 'follow' | 'inspect' | 'survey' | 'slow' | 'standard' | 'fast';

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
  alt: number;               // m, relative
  alt_m?: number;
  profile?: MissionProfile;  // optional speed override for this leg
  speed_mps?: number;
}

export interface OrbitPointTool {
  tool: 'orbit_point';
  lat: number;
  lon: number;
  radius: number;            // m
  radius_m?: number;
  laps?: number;
}

export interface HoldTool {
  tool: 'hold';
  durationS?: number;        // seconds; omitted = indefinite
  duration_s?: number;
}

export interface RtlTool {
  tool: 'rtl';
}

export interface FollowTool { tool: 'follow'; track_id: number; profile: MissionProfile; trackId?: number; }
export interface OrbitTool { tool: 'orbit'; track_id: number; profile: MissionProfile; trackId?: number; }
export interface GotoRelativeTool { tool: 'goto_relative'; dx: number; dy: number; dz: number; }
export type PlanTool = FollowTool | OrbitTool | GotoRelativeTool | GotoGpsTool | OrbitPointTool | HoldTool | RtlTool;
export type AnomalySource = 'sentinel2' | 'sar' | 'sdr' | 'rf_drone' | 'drone_survey' | 'cctv';

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

/* ---------------------------------------------------------------------------
 * Commands.  The base PRD §4 set plus the manual-piloting extension that was
 * added when the UI was built (engageManual / disengageManual).  High-rate
 * stick input is NOT a command — it travels via setManualInput() / the
 * `manualInput` wire message and bypasses the ack path.
 *
 * Note for the backend: CODE_PRD §5.2 refers to `takeManualControl` /
 * `releaseManualControl` / `manualInput`.  Those map exactly onto the UI's
 * authoritative names used here:
 *     takeManualControl   === engageManual     (acked command)
 *     releaseManualControl=== disengageManual  (acked command)
 *     manualInput         === the `manualInput` wire message (fire-and-forget)
 * ------------------------------------------------------------------------- */
export type CommandName =
  | 'arm' | 'disarm' | 'takeoff' | 'land' | 'rtl' | 'setMode'
  | 'engageTracking' | 'disengageTracking' | 'selectTarget'
  | 'setStandoff' | 'setMaxSpeed' | 'emergencyStop'
  | 'engageManual' | 'disengageManual'
  | 'executePlan' | 'abortPlan' | 'continueMission' | 'testFault';

/** SITL-only; reject unless config.sitl && EIS_ENABLE_TEST_HOOKS=true. */
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
    fault?: TestFaultName;
    enabled?: boolean;
    value?: number;
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

/** High-rate manual stick input. Each axis is bipolar, normalised -1..1:
 *   throttle = climb/descend, yaw = yaw rate, pitch = forward/back, roll = left/right.
 *  Delivered via DataSource.setManualInput() and serialised to the wire as a
 *  `manualInput` message — fire-and-forget, never acked per frame. */
export interface ManualInput {
  throttle: number;
  yaw: number;
  pitch: number;
  roll: number;
}

/** The on-the-wire form of a manual stick frame (ground -> companion). */
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

export type SensorModality = 'rgb' | 'thermal' | 'lidar' | 'fused';
export type SensorHealth = 'ok' | 'degraded' | 'failed';
export interface ObservationTrack {
  id: number; class: string; bearing_deg: number; range_m: number; conf: number;
  modality: SensorModality; thermal_delta_c?: number;
}
export interface ObservationGeometry {
  fence_gaps: Array<{ lat: number; lon: number; width_m: number }>;
  new_structures: Array<{ lat: number; lon: number; footprint_m2: number; height_m: number }>;
}
export interface ObservationMessage {
  type: 'observation'; ts: number; vehicleId: string; tracks: ObservationTrack[]; scene: string;
  sensors: { rgb: SensorHealth; thermal: SensorHealth; lidar: SensorHealth };
  geometry: ObservationGeometry;
  /** Data URL or repo-relative staged-image path for recognizer/UI use. */
  frames?: { rgb?: string; thermal?: string };
  missionId?: string;
  stagingId?: string;
}
export interface CapabilityProfile {
  profile: MissionProfile; min_standoff_m: number; max_standoff_m: number;
  max_speed_mps: number; max_altitude_m: number;
}
export interface CapabilitiesMessage {
  type: 'capabilities'; ts: number; vehicleId: string; profiles: CapabilityProfile[];
  sensors: SensorModality[]; night_capable: boolean; max_sortie_s: number; dispatch_min_soc_pct: number;
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
export interface ReadinessMessage {
  type: 'readiness'; ts: number; vehicleId: string; ready: boolean; reasons: string[]; eta_ready_s: number;
}
export type HealthComponent = 'link' | 'planner' | 'gps' | 'battery' | 'wind' | 'camera' | 'thermal' | 'lidar' | 'site_model' | 'mesh' | 'sdr';
export interface HealthEventMessage {
  type: 'healthEvent'; ts: number; vehicleId: string; component: HealthComponent; state: string; detail: string;
}
export type RfSource = 'sdr' | 'rf_drone';
export type RfEventKind = 'gnss_interference' | 'drone_link' | 'remote_id' | 'hostile_drone';
export interface RfEventMessage {
  type: 'rfEvent'; ts: number; vehicleId: string; source: RfSource; kind: RfEventKind; band: string;
  power_delta_db?: number; lat?: number; lon?: number; pilot_lat?: number; pilot_lon?: number; confidence: number;
}
export interface SpectrumBand { name: string; floor_db: number; p95_db: number; peak_mhz: number; occ_bw_mhz: number; }
export interface SpectrumMessage {
  type: 'spectrum'; ts: number; vehicleId: string; bands: SpectrumBand[]; state: 'warming' | 'nominal' | 'degraded';
}
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

export type ConnectionState =
  | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionConfig {
  host: string;            // Jetson IP, or 'sitl'
  controlPort: number;     // websocket control/telemetry port, default 8765
  videoUrl: string;        // rtsp/webrtc/http url, or '' for mock
  sitl: boolean;
}

/** Any message the companion may push to the ground over the control socket. */
export type InboundMessage =
  | Telemetry | TrackingStatus | StatusText | CommandAck
  | AnomalyMessage | MissionPlanMessage | VerificationMessage | IncidentReportMessage
  | ObservationMessage | CapabilitiesMessage | PlanCommandAckMessage | ReadinessMessage
  | HealthEventMessage | RfEventMessage | SpectrumMessage | FleetMessage;
/** Any message the ground may send to the companion over the control socket. */
export type OutboundMessage =
  | Command | ManualInputMessage | PlanCommandMessage | PlanHeartbeatMessage | RfEventMessage;

export type Unsubscribe = () => void;

/* ---------------------------------------------------------------------------
 * The DataSource interface — the one seam the entire UI consumes data through.
 * MockDataProvider and LiveDataProvider both implement it; selecting which is a
 * single line in `ground/ui/src/dataSource/index.ts`.
 * ------------------------------------------------------------------------- */
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
   *  MockDataProvider returns '' and the UI renders the mock canvas scene instead. */
  getVideoUrl(): string;
}

/* Default connection + tuning constants, shared so UI and backend agree. */
export const DEFAULTS = {
  vehicleId: DEFAULT_VEHICLE_ID,
  controlPort: 8765,
  videoPort: 8554,
  standoffDistance: 5,      // m  (PRD §9)
  minStandoff: 3,           // m  (hard floor)
  maxStandoff: 15,          // m
  maxSpeed: 2,              // m/s (PRD §9 conservative default)
  maxSpeedCap: 8,           // m/s
  minSpeed: 0.5,            // m/s
  maxClimbRate: 1.5,        // m/s
  maxYawRate: 45,           // deg/s
  maxAltitude: 30,          // m  (geofence altitude cap)
  geofenceRadius: 60,       // m
  manualWatchdogMs: 500,    // zero setpoint + hold if no stick frame within this
  groundLinkTimeoutMs: 2000,// deadman: stop guidance + hold/RTL if link drops
  deadzone: 0.09,
} as const;
