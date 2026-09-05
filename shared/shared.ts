/* ============================================================================
 * Eye in the Sky — SHARED CONTRACT (TypeScript)
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
export type InboundMessage = Telemetry | TrackingStatus | StatusText | CommandAck;
/** Any message the ground may send to the companion over the control socket. */
export type OutboundMessage = Command | ManualInputMessage;

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
