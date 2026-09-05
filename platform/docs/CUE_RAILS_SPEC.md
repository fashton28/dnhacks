# Cue adapter integration specification

No separate root cue specification was present. This document records the
requirements in the authorized brief, without inventing a Guardian or VMS SDK.

All rails implement start/stop, onAnomaly, health and whitelist. Output is an
`anomaly` with vehicleId, source, observedAt (Unix milliseconds), ttl_s, confidence,
location and optional cameraId. CCTV event provenance is audit-only. Expired,
invalid, duplicate or whitelisted cues cannot dispatch. Scripted fixtures are
selected explicitly; live rail failures do not stop other rails.

Rails: sentinel2, sar, sdr, rf_drone (Guardian-shaped passive event adapter),
cctv (VMS event first; calibrated one-stream pixel fallback), fence_sensor
(fixture only), drone_survey (stub). No rail introduces a command or new wire
message. Existing satellite/RF algorithms remain reusable behind the adapters.

Cameras define WGS84 position, heading/FOV/range, FOV polygon and named zone
polygons. Event cues use zone centroids. Pixel cues use bearing across image width
and calibrated box-height range, then clamp to FOV. Invalid calibration or a cue
outside operational geofence produces a warning and no dispatch. Class confidence
does not establish identity, intent or authorization. Fixed-camera frames retain
cue-time provenance alongside drone RGB/thermal observations.

Normalcy supplies staffed hours, active gates and delivery windows. Per-camera
rate limits precede the shared dispatch budget. Blue-force RF whitelisting requires
an authenticated own-vehicle telemetry fingerprint, never a model assertion.
Correlate only fresh evidence: RF with fence-zone motion gives priority 1;
RF with SDR interference escalates without flight.

Generic VMS ingress accepts `{cameraId, zone, class?, ts, thumbnail?}`. An ONVIF
bridge maps motion topic/source camera token and region ID to those fields;
authentication and vendor transport are outside the generic event parser.
