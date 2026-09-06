/**
 * Flight instruments: SVG dials and bar gauges fed straight from telemetry.
 * Each module also exports the pure classification / formatting helper it is
 * built on, so thresholds and readouts are testable without a DOM.
 */
export { AttitudeIndicator, signedDegrees, pitchLadder, ladderPath, pitchScale, polar, radialTicks } from './AttitudeIndicator';
export type { AttitudeIndicatorProps, LadderMark } from './AttitudeIndicator';

export { Compass, formatHeading, normalizeHeading, compassTicks } from './Compass';
export type { CompassProps } from './Compass';

export { BatteryGauge, batteryStatus, batteryFillPercent, BATTERY_CAUTION_PCT, BATTERY_CRITICAL_PCT } from './BatteryGauge';
export type { BatteryGaugeProps, BatteryStatus } from './BatteryGauge';

export { SignalGauge, signalLevel, signalReadout, RSSI_FLOOR_DBM, RSSI_CEILING_DBM } from './SignalGauge';
export type { SignalGaugeProps, SignalLevel, SignalStatus } from './SignalGauge';
