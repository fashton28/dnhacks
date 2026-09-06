/* Panels barrel.
 *
 * The flight-ops panels export an explicit surface: the component, its prop
 * types, and the pure helpers their tests pin. The mission-retrofit panels
 * re-export wholesale. */

export { StatusBar, formatFlightTime, gpsFixLabel, connectionPill, hostCaption, padIndicatorState } from './StatusBar';
export type { StatusBarProps, LinkPillSpec, PadIndicatorState } from './StatusBar';

export {
  ControlsPanel,
  MODE_CHIPS,
  AIRBORNE_ALT_M,
  STANDOFF_SLIDER,
  MAX_SPEED_SLIDER,
  isAirborne,
  flightGates,
  trackingPill,
} from './ControlsPanel';
export type { ControlsPanelProps, SendCmd, FlightGates } from './ControlsPanel';

export {
  ManualControl,
  MANUAL_DEADZONE,
  MANUAL_ZERO,
  MANUAL_RELEASE_BUTTON,
  MANUAL_KEY_MAP,
  isManualKey,
  applyDeadzone,
  manualInputFromAxes,
  manualInputFromKeys,
  sameInput,
  padDisplayName,
  formatChannel,
} from './ManualControl';
export type { ManualControlProps } from './ManualControl';

export {
  TelemetryPanel,
  BATTERY_DANGER_PCT,
  BATTERY_CAUTION_PCT,
  batteryBand,
  verticalTrend,
  sparklinePath,
} from './TelemetryPanel';
export type { TelemetryPanelProps, BatteryBand } from './TelemetryPanel';

export { LogConsole, LOG_FILTERS, SEVERITY_TAG, logMatchesFilter, filterLogs, logClock } from './LogConsole';
export type { LogConsoleProps, LogFilter } from './LogConsole';

export { VideoPanel, TRACK_CHIP, videoSourceKind, whepEndpoint, targetCaption, paintMockScene } from './VideoPanel';
export type { VideoSourceKind } from './VideoPanel';

export {
  MapPanel,
  MAP_MIN_ZOOM,
  MAP_INITIAL_ZOOM,
  DEFAULT_GEOFENCE_M,
  ASSUMED_TARGET_RANGE_M,
  tileBadge,
  clampZoom,
  offsetByBearing,
  targetPosition,
  mapCoordLabel,
} from './MapPanel';
export type { MapTileSource } from './MapPanel';

// Mission (power-plant security) retrofit panels:
export * from './MissionMap';
export * from './SatellitePanel';
export * from './VerifierPanel';
export * from './ReportPanel';
export * from './AuditLogPanel';
export * from './ObservationPanel';
export * from './MissionStatusStrip';
export * from './SimulationPanel';
export * from './TaskPlanPanel';
