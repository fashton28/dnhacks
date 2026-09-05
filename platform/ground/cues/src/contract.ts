/* ============================================================================
 * eis-cues — structural copies of the FROZEN wire types this package emits.
 *
 * The authoritative contract is ground/ui/src/contract/index.ts. It is never
 * imported from src/ (it lives outside this package's rootDir and would break
 * the dist build); TypeScript is structural, so values built against these
 * interfaces ARE contract values, and test/contract-compat.test.ts asserts
 * mutual assignability against the real contract at typecheck time — any drift
 * fails `npm run typecheck`.
 *
 * CUE RAILS ADD NO WIRE MESSAGES. Everything a rail produces is either an
 * `anomaly` or a `healthEvent` that already exists in the contract.
 * ========================================================================== */

/** Contract `AnomalySource`. Each value is exactly one cue rail. */
export type AnomalySource =
  | 'sentinel2' | 'sar' | 'sdr' | 'rf_drone' | 'drone_survey'
  | 'cctv' | 'fence_sensor';

/** Contract `Anomaly`. `type` is the anomaly KIND, not a message discriminant. */
export interface Anomaly {
  id: string;
  lat: number;
  lon: number;
  type: string;        // anomaly kind, e.g. 'change'
  confidence: number;  // 0..1
  thumbnail: string;   // repo-relative path or data URL
  source: AnomalySource;
  /** Epoch ms the cue was OBSERVED. Every rail in this package sets it. */
  observedAt?: number;
  /** Cue lifetime in seconds from `observedAt`. Every rail here sets it. */
  ttl_s?: number;
  /** Fixed camera that raised the cue (`site.cameras[].id`), when any. */
  cameraId?: string;
}

/** Contract `AnomalyMessage` — the ONLY channel a cue rail dispatches on. */
export interface AnomalyMessage {
  type: 'anomaly';
  ts: number;
  vehicleId: string;
  anomaly: Anomaly;
}

/** Contract `HealthComponent`. No rail-specific component exists yet, so each
 *  rail maps onto the closest published component and always names itself in
 *  `detail` (see RAIL_HEALTH_COMPONENT). */
export type HealthComponent =
  | 'link' | 'planner' | 'gps' | 'battery' | 'wind' | 'camera'
  | 'thermal' | 'lidar' | 'site_model' | 'mesh' | 'sdr' | 'envelope';

/** Contract `HealthEventMessage`. */
export interface HealthEventMessage {
  type: 'healthEvent';
  ts: number;
  vehicleId: string;
  component: HealthComponent;
  state: string;
  detail: string;
}

/** Contract `CctvEventMessage` — audit/provenance only. It never carries a
 *  dispatch, a route or an altitude; the dispatchable form of a camera cue is
 *  an `Anomaly` with source 'cctv'. */
export interface CctvEventMessage {
  type: 'cctvEvent';
  ts: number;
  vehicleId: string;
  cameraId: string;
  zone: string;
  class?: string;
  thumbnail?: string;
}

/** Contract `DEFAULT_VEHICLE_ID`. Every message this package emits carries a
 *  vehicleId; nothing defaults it silently at the wire boundary. */
export const DEFAULT_VEHICLE_ID = 'eis-1';

export type Unsubscribe = () => void;
