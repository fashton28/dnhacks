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
 *  is ever active (auto guidance, autonomous tracking, or manual sticks). */
export type ControlSource = 'auto' | 'tracking' | 'manual';

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
  | 'engageManual' | 'disengageManual';

export interface Command {
  type: 'command';
  command: CommandName;
  params?: {
    altitude?: number;     // takeoff, m
    mode?: Mode;           // setMode
    targetId?: number;     // selectTarget
    meters?: number;       // setStandoff
    mps?: number;          // setMaxSpeed
  };
}

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

export type ConnectionState =
  | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionConfig {
  host: string;            // Jetson IP, or 'sitl'
  controlPort: number;     // websocket control/telemetry port, default 8765
  videoUrl: string;        // rtsp/webrtc/http url, or '' for mock
  sitl: boolean;
}

export type InboundMessage = Telemetry | TrackingStatus | StatusText | CommandAck;
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
