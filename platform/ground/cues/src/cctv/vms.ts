/* ============================================================================
 * eis-cues/cctv — generic VMS event ingress (the PRIMARY camera path).
 *
 * A VMS event is preferred over pixel analysis (ADR D25): the video management
 * system already ran the detector, and its event names the camera and the zone
 * the site model knows. This module owns the generic parser only —
 * authentication and vendor transport (webhook POST, REST poll, ONVIF PullPoint)
 * live outside it, so no vendor SDK is invented here.
 *
 * Wire-in shape (the generic contract, per docs/CUE_RAILS_SPEC.md):
 *
 *   { cameraId: string, zone: string, class?: string, ts: number,
 *     thumbnail?: string, id?: string, confidence?: number }
 *
 * `ts` is epoch milliseconds and becomes the cue's `observedAt` — a VMS event
 * is always older than the message that carries it, and the TTL is measured
 * from when the camera SAW something, never from when we heard about it.
 *
 * ONVIF mapping note
 * ------------------
 * An ONVIF bridge subscribes to the device's event service and maps its
 * notifications onto the generic shape above:
 *
 *   Topic `tns1:VideoSource/MotionAlarm`      → a motion cue
 *   Topic `tns1:RuleEngine/CellMotionDetector/Motion`
 *                                             → a motion cue
 *   Topic `tns1:RuleEngine/LineDetector/Crossed`
 *                                             → a line-crossing cue
 *   Source item `VideoSourceConfigurationToken`
 *     (or `VideoSourceToken`)                 → cameraId
 *   Source item `RuleName` / `Rule` / `RegionID`
 *                                             → zone
 *   Message `UtcTime` attribute               → ts (epoch ms)
 *   Data item `ObjectType` / `ClassType`      → class
 *
 * `mapOnvifNotification` does exactly that mapping and nothing else: it does
 * not open a subscription, authenticate, or renew a PullPoint — a real bridge
 * supplies those and hands the parsed notification here.
 * ========================================================================== */

/** The generic VMS event every camera integration is normalised to. */
export interface VmsEvent {
  cameraId: string;
  zone: string;
  /** Epoch ms the camera observed it. */
  ts: number;
  class?: string;
  thumbnail?: string;
  /** VMS-side event id, when the system provides a stable one. */
  id?: string;
  /** VMS-reported confidence, 0..1, when the system provides one. */
  confidence?: number;
}

/**
 * Confidence by coarse class.
 *
 * A class label is a DETECTOR OUTPUT, not an identity, an intent or an
 * authorisation (docs/CUE_RAILS_SPEC.md). These values only rank cues for
 * triage; nothing downstream may read them as "this is an intruder".
 */
export const CLASS_CONFIDENCE: Record<string, number> = {
  person: 0.72,
  vehicle: 0.66,
  truck: 0.66,
  car: 0.62,
  bicycle: 0.55,
  animal: 0.35,
  unknown: 0.40,
  motion: 0.40,
};

/** Confidence used when the VMS reports no class at all. */
export const UNCLASSED_CONFIDENCE = 0.40;

/** Anomaly KIND for a camera cue, by class. Never an identity claim. */
export function cctvCueType(cls?: string): string {
  if (cls === 'person') return 'person_in_zone';
  if (cls === 'vehicle' || cls === 'truck' || cls === 'car') return 'vehicle_in_zone';
  return 'motion_in_zone';
}

/** Confidence for a VMS event: the VMS's own number when it gives one, else the
 *  class table, else the unclassed default. */
export function vmsConfidence(event: VmsEvent): number {
  if (typeof event.confidence === 'number' && Number.isFinite(event.confidence) &&
      event.confidence >= 0 && event.confidence <= 1) {
    return event.confidence;
  }
  if (event.class && event.class in CLASS_CONFIDENCE) return CLASS_CONFIDENCE[event.class];
  return UNCLASSED_CONFIDENCE;
}

/** Validate one untrusted VMS record. Throws with a specific reason. */
export function parseVmsEvent(input: unknown): VmsEvent {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid VMS event: record must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.cameraId !== 'string' || raw.cameraId === '') {
    throw new Error('invalid VMS event: cameraId must be a non-empty string');
  }
  if (typeof raw.zone !== 'string' || raw.zone === '') {
    throw new Error('invalid VMS event: zone must be a non-empty string');
  }
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts) || raw.ts < 0) {
    throw new Error('invalid VMS event: ts must be a non-negative epoch-ms number');
  }
  if (raw.class !== undefined && typeof raw.class !== 'string') {
    throw new Error('invalid VMS event: class must be a string when present');
  }
  if (raw.thumbnail !== undefined && typeof raw.thumbnail !== 'string') {
    throw new Error('invalid VMS event: thumbnail must be a string when present');
  }
  if (raw.id !== undefined && typeof raw.id !== 'string') {
    throw new Error('invalid VMS event: id must be a string when present');
  }
  if (raw.confidence !== undefined &&
      (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) ||
       raw.confidence < 0 || raw.confidence > 1)) {
    throw new Error('invalid VMS event: confidence must be a number in [0, 1] when present');
  }
  return {
    cameraId: raw.cameraId,
    zone: raw.zone,
    ts: raw.ts,
    ...(raw.class === undefined ? {} : { class: raw.class }),
    ...(raw.thumbnail === undefined ? {} : { thumbnail: raw.thumbnail }),
    ...(raw.id === undefined ? {} : { id: raw.id }),
    ...(raw.confidence === undefined ? {} : { confidence: raw.confidence }),
  };
}

/** The already-parsed shape an ONVIF bridge hands over (see the module note). */
export interface OnvifNotification {
  topic: string;
  /** ONVIF Source SimpleItems, e.g. { VideoSourceConfigurationToken, RuleName }. */
  source: Record<string, string>;
  /** ONVIF Data SimpleItems, e.g. { IsMotion: 'true', ObjectType: 'Person' }. */
  data?: Record<string, string>;
  /** Message UtcTime, ISO 8601. */
  utcTime: string;
}

const ONVIF_CAMERA_KEYS = [
  'VideoSourceConfigurationToken', 'VideoSourceToken', 'Source', 'SourceToken',
];
const ONVIF_ZONE_KEYS = ['RuleName', 'Rule', 'RegionID', 'Region', 'AnalyticsRegion'];
const ONVIF_CLASS_KEYS = ['ObjectType', 'ClassType', 'Type'];

const ONVIF_MOTION_TOPICS = [
  'tns1:VideoSource/MotionAlarm',
  'tns1:RuleEngine/CellMotionDetector/Motion',
  'tns1:RuleEngine/LineDetector/Crossed',
  'tns1:RuleEngine/FieldDetector/ObjectsInside',
];

function firstOf(bag: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = bag[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/**
 * Map one ONVIF notification onto the generic VMS event.
 *
 * Returns null for a topic the bridge does not carry (an un-mapped topic is
 * ignored, never guessed at). Throws when a carried topic is missing the camera
 * token, the region, or a usable timestamp — a cue whose provenance cannot be
 * established is refused, not defaulted.
 */
export function mapOnvifNotification(n: OnvifNotification): VmsEvent | null {
  if (!ONVIF_MOTION_TOPICS.includes(n.topic)) return null;
  if (n.data?.IsMotion === 'false' || n.data?.State === 'false') return null;
  const cameraId = firstOf(n.source, ONVIF_CAMERA_KEYS);
  if (!cameraId) {
    throw new Error('invalid ONVIF notification: no video source token to map onto cameraId');
  }
  const zone = firstOf(n.source, ONVIF_ZONE_KEYS);
  if (!zone) {
    throw new Error('invalid ONVIF notification: no rule/region to map onto zone');
  }
  const ts = Date.parse(n.utcTime);
  if (!Number.isFinite(ts)) {
    throw new Error('invalid ONVIF notification: UtcTime is not a parseable timestamp');
  }
  const cls = n.data ? firstOf(n.data, ONVIF_CLASS_KEYS) : undefined;
  return {
    cameraId,
    zone,
    ts,
    ...(cls === undefined ? {} : { class: cls.toLowerCase() }),
  };
}
