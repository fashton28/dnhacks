/* ============================================================================
 * Eye in the Sky — SHARED CONTRACT (authoritative copy)
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

export interface Telemetry {
  type: 'telemetry';
  ts: number;                       // epoch ms
  armed: boolean;
  mode: Mode;
  controlSource?: ControlSource;    // additive; authoritative active control source
  attitude: { roll: number; pitch: number; yaw: number };   // degrees
  position: { lat: number; lon: number; relAlt: number; absAlt: number }; // m
  velocity: { groundspeed: number; verticalSpeed: number }; // m/s
  heading: number;                  // degrees 0..360
  battery: { voltage: number; current: number; remaining: number }; // V, A, %
  gps: { fixType: number; satellites: number; hdop: number };
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
  severity: 'info' | 'warning' | 'error' | 'critical';
  text: string;
}

/* ---------------------------------------------------------------------------
 * Mission planner types (anomaly → plan → verification → incident report).
 * ------------------------------------------------------------------------- */

/** Named speed profile for planned missions. */
export type MissionProfile = 'slow' | 'standard' | 'fast';

/** Cruise speed per profile, m/s. These MUST stay under the companion
 *  config.py hard max-speed cap (8 m/s — DEFAULTS.maxSpeedCap). */
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
  alt: number;               // m, relative
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
  | 'executePlan' | 'abortPlan';

export interface Command {
  type: 'command';
  command: CommandName;
  params?: {
    altitude?: number;     // takeoff, m
    mode?: Mode;           // setMode
    targetId?: number;     // selectTarget
    meters?: number;       // setStandoff
    mps?: number;          // setMaxSpeed
    plan?: MissionPlan;    // executePlan: the full verified plan (abortPlan takes no params)
  };
}

/** Acks correlate by command NAME (first-match FIFO) — there is no requestId
 *  on the ack path. The `requestId` inside MissionPlan / Verification exists
 *  for ground-side correlation only and never participates in ack matching. */
export interface CommandAck {
  type: 'ack';
  ts: number;
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
}

/* Planner wire/event messages. Payloads are NESTED (e.g. `anomaly.type` is the
 * anomaly kind) so payload fields never collide with the message `type`
 * discriminant. They flow ground-internally through DataSource today and may
 * later cross the socket unchanged. */
export interface AnomalyMessage {
  type: 'anomaly';
  ts: number;
  anomaly: Anomaly;
}

export interface MissionPlanMessage {
  type: 'missionPlan';
  ts: number;
  plan: MissionPlan;
}

export interface VerificationMessage {
  type: 'verification';
  ts: number;
  verification: Verification;
}

export interface IncidentReportMessage {
  type: 'incidentReport';
  ts: number;
  report: IncidentReport;
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
  | AnomalyMessage | MissionPlanMessage | VerificationMessage | IncidentReportMessage;
export type OutboundMessage = Command | ManualInputMessage;

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
