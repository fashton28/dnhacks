/* Pure formatting and gating helpers factored out of the StatusBar, LogConsole,
 * TelemetryPanel and ControlsPanel. */
import { describe, expect, it } from 'vitest';
import type { StatusText } from '@/contract';
import { connectionPill, formatFlightTime, gpsFixLabel, hostCaption, padIndicatorState } from '@/panels/StatusBar';
import { LOG_FILTERS, SEVERITY_TAG, filterLogs, logClock, logMatchesFilter } from '@/panels/LogConsole';
import { batteryBand, sparklinePath, verticalTrend } from '@/panels/TelemetryPanel';
import { AIRBORNE_ALT_M, MODE_CHIPS, flightGates, isAirborne, trackingPill } from '@/panels/ControlsPanel';

describe('StatusBar helpers', () => {
  it('formats the flight clock as MM:SS and keeps counting past an hour', () => {
    expect(formatFlightTime(0)).toBe('00:00');
    expect(formatFlightTime(65)).toBe('01:05');
    expect(formatFlightTime(3725)).toBe('62:05');
    expect(formatFlightTime(59.9)).toBe('00:59');
    expect(formatFlightTime(-4)).toBe('00:00');
  });

  it('labels MAVLink fix types and reads anything unknown as 3D', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(gpsFixLabel)).toEqual(['NO GPS', 'NO FIX', '2D', '3D', 'DGPS', 'RTK', 'RTK']);
    expect(gpsFixLabel(7)).toBe('3D');
    expect(gpsFixLabel(-1)).toBe('3D');
  });

  it('maps connection state onto the pill', () => {
    expect(connectionPill('connected')).toEqual({ status: 'nominal', label: 'Connected', pulse: false });
    expect(connectionPill('connecting')).toEqual({ status: 'caution', label: 'Connecting', pulse: true });
    expect(connectionPill('disconnected')).toEqual({ status: 'danger', label: 'Disconnected', pulse: false });
    expect(connectionPill('error')).toEqual({ status: 'danger', label: 'Disconnected', pulse: false });
  });

  it('prefers the explicit host, then sitl, then the placeholder, then a dash', () => {
    expect(hostCaption('10.0.0.7', true, true)).toBe('10.0.0.7');
    expect(hostCaption(undefined, true, false)).toBe('sitl');
    expect(hostCaption(undefined, false, true)).toBe('192.168.1.42');
    expect(hostCaption(undefined, false, false)).toBe('—');
  });

  it('manual beats a connected pad in the controller indicator', () => {
    expect(padIndicatorState(true, false)).toBe('manual');
    expect(padIndicatorState(true, true)).toBe('manual');
    expect(padIndicatorState(false, true)).toBe('pad');
    expect(padIndicatorState(false, false)).toBe('none');
  });
});

describe('LogConsole helpers', () => {
  const entry = (severity: StatusText['severity'], text = severity): StatusText => ({
    type: 'statusText', ts: 0, vehicleId: 'eis-1', severity, text,
  });
  const all = [entry('info'), entry('warning'), entry('error'), entry('critical')];

  it('offers All / Alerts / Info', () => {
    expect(LOG_FILTERS.map((f) => f.id)).toEqual(['all', 'warn', 'info']);
    expect(LOG_FILTERS.map((f) => f.label)).toEqual(['All', 'Alerts', 'Info']);
  });

  it('Alerts admits every non-info severity, Info only info, All everything', () => {
    expect(filterLogs(all, 'all').map((e) => e.severity)).toEqual(['info', 'warning', 'error', 'critical']);
    expect(filterLogs(all, 'warn').map((e) => e.severity)).toEqual(['warning', 'error', 'critical']);
    expect(filterLogs(all, 'info').map((e) => e.severity)).toEqual(['info']);
    expect(logMatchesFilter(entry('critical'), 'info')).toBe(false);
  });

  it('keeps the severity column four characters wide', () => {
    for (const tag of Object.values(SEVERITY_TAG)) expect(tag).toHaveLength(4);
    expect(SEVERITY_TAG.error).toBe('ERR ');
  });

  it('renders local HH:MM:SS and never throws on a bad timestamp', () => {
    const d = new Date(2026, 8, 6, 7, 4, 9);
    expect(logClock(d.getTime())).toBe('07:04:09');
    expect(logClock(Number.NaN)).toBe('--:--:--');
  });
});

describe('TelemetryPanel helpers', () => {
  it('bands the battery at 30 % and 15 %', () => {
    expect(batteryBand(100)).toBe('nominal');
    expect(batteryBand(31)).toBe('nominal');
    expect(batteryBand(30)).toBe('caution');
    expect(batteryBand(16)).toBe('caution');
    expect(batteryBand(15)).toBe('danger');
    expect(batteryBand(0)).toBe('danger');
  });

  it('treats ±0.1 m/s as level', () => {
    expect(verticalTrend(0.5)).toBe('up');
    expect(verticalTrend(-0.5)).toBe('down');
    expect(verticalTrend(0.1)).toBeNull();
    expect(verticalTrend(-0.1)).toBeNull();
    expect(verticalTrend(0)).toBeNull();
  });

  it('spreads samples across the width and scales them to the range with padding', () => {
    expect(sparklinePath([0, 10], 100, 34)).toBe('M0.00 32.00 L100.00 2.00');
    expect(sparklinePath([5, 5, 5], 100, 34)).toBe('M0.00 32.00 L50.00 32.00 L100.00 32.00');
    expect(sparklinePath([], 100, 34)).toBe('M0.00 32.00');
  });
});

describe('ControlsPanel helpers', () => {
  it('counts the vehicle as airborne above half a metre', () => {
    expect(AIRBORNE_ALT_M).toBe(0.5);
    expect(isAirborne(null)).toBe(false);
    expect(isAirborne({ position: { relAlt: 0.5 } } as never)).toBe(false);
    expect(isAirborne({ position: { relAlt: 0.51 } } as never)).toBe(true);
  });

  it('gates takeoff on armed-and-grounded, land/RTL/tracking on airborne, and nags until the checklist is done', () => {
    expect(flightGates({ armed: false, flying: false, checklistDone: false })).toEqual({
      canTakeoff: false, canLand: false, canRtl: false, canEngageTracking: false, checklistNag: true,
    });
    expect(flightGates({ armed: true, flying: false, checklistDone: true })).toEqual({
      canTakeoff: true, canLand: false, canRtl: false, canEngageTracking: false, checklistNag: false,
    });
    expect(flightGates({ armed: true, flying: true, checklistDone: true })).toEqual({
      canTakeoff: false, canLand: true, canRtl: true, canEngageTracking: true, checklistNag: false,
    });
    expect(flightGates({ armed: true, flying: false, checklistDone: false }).checklistNag).toBe(false);
  });

  it('offers the five one-tap modes in order', () => {
    expect(MODE_CHIPS).toEqual(['LOITER', 'GUIDED', 'ALT_HOLD', 'POSHOLD', 'BRAKE']);
  });

  it('colours the tracking pill by state and pulses only when locked', () => {
    expect(trackingPill('idle')).toEqual({ status: 'neutral', pulse: false });
    expect(trackingPill('searching')).toEqual({ status: 'info', pulse: false });
    expect(trackingPill('locked')).toEqual({ status: 'caution', pulse: true });
    expect(trackingPill('lost')).toEqual({ status: 'danger', pulse: false });
  });
});
