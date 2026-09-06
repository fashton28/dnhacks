/* StatusBar, ControlsPanel, TelemetryPanel and LogConsole as the operator sees
 * them, rendered with react-dom/server. These pin the visible contract:
 * which controls appear, which are disabled, and what each state is called. */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EnvelopeMessage, StatusText, Telemetry, TrackingStatus } from '@/contract';
import { StatusBar } from '@/panels/StatusBar';
import { ControlsPanel } from '@/panels/ControlsPanel';
import { TelemetryPanel } from '@/panels/TelemetryPanel';
import { LogConsole } from '@/panels/LogConsole';

const noop = (): void => {};

/** The opening <button …> tag whose content includes `label`. */
function buttonTagFor(html: string, label: string): string {
  const at = html.indexOf(label);
  expect(at, `no "${label}" in markup`).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<button', at);
  return html.slice(open, html.indexOf('>', open) + 1);
}

const telemetry = (over: Partial<Telemetry> = {}): Telemetry =>
  ({
    armed: false,
    mode: 'GUIDED',
    navSource: 'gps',
    attitude: { roll: 2, pitch: -1, yaw: 0 },
    position: { lat: 1.3521, lon: 103.8198, relAlt: 0, absAlt: 20 },
    velocity: { groundspeed: 1.25, verticalSpeed: 0.4 },
    heading: 270,
    battery: { remaining: 22, voltage: 15.1, current: 4 },
    gps: { fixType: 3, satellites: 14, hdop: 0.9 },
    home: { lat: 1.35, lon: 103.81, distance: 37.4 },
    link: { rssi: -55, latencyMs: 40 },
    ...over,
  }) as Telemetry;

describe('StatusBar', () => {
  const render = (over: Partial<React.ComponentProps<typeof StatusBar>> = {}): string =>
    renderToStaticMarkup(
      React.createElement(StatusBar, {
        tel: null, connState: 'disconnected', sitl: false, elapsed: 65,
        controllerOn: false, manualActive: false, onDisarm: noop, onOpenSettings: noop, ...over,
      }),
    );

  it('reads sensibly before any telemetry', () => {
    const html = render();
    expect(html).toContain('Disconnected');
    expect(html).toContain('01:05');
    expect(html).toContain('Disarmed');
    expect(html).toContain('LOITER');
    expect(html).toContain('GPS · NO GPS');
    expect(html).toContain('— sats');
    expect(html).toContain('NO PAD');
    expect(html).toContain('DISARM');
    expect(html).toContain('Disarm / Kill (Space)');
    expect(html).toContain('ENVELOPE ?');
    expect(html).toContain('OUTBOX 0');
  });

  it('labels the data source MOCK / SITL / LIVE', () => {
    expect(render({ sourceKind: 'mock' })).toContain('MOCK');
    expect(render({ sourceKind: 'mock', sitl: true })).toContain('MOCK');
    expect(render({ sourceKind: 'live', sitl: true })).toContain('SITL');
    expect(render({ sourceKind: 'live' })).toContain('LIVE');
    expect(render({ sourceKind: 'hub' })).toContain('LIVE');
    expect(render({ sitl: true })).toContain('sitl');
    expect(render({ host: 'hub.local:8080' })).toContain('hub.local:8080');
  });

  it('reflects the vehicle once telemetry arrives', () => {
    const html = render({ tel: telemetry({ armed: true }), connState: 'connected', controllerOn: true });
    expect(html).toContain('Connected');
    expect(html).toContain('Armed');
    expect(html).toContain('GUIDED');
    expect(html).toContain('GPS · 3D');
    expect(html).toContain('14 sats');
    expect(html).toContain('PAD');
    expect(html).toContain('GPS');
  });

  it('shows MANUAL over PAD while manual is active', () => {
    expect(render({ controllerOn: true, manualActive: true })).toContain('MANUAL');
  });

  it('renders the optional tool buttons only when their handlers exist', () => {
    const bare = render();
    expect(bare).toContain('title="Settings"');
    expect(bare).not.toContain('title="PID tuning"');
    const full = render({ onOpenFailsafe: noop, onOpenPid: noop, onOpenLogs: noop });
    for (const title of ['Failsafe settings', 'PID tuning', 'Log browser', 'Settings']) expect(full).toContain(`title="${title}"`);
  });

  it('keeps the fleet selector, envelope and attendance chips', () => {
    const envelope: EnvelopeMessage = { type: 'envelope', ts: 0, vehicleId: 'eis-2', state: 'breach', constraint: 'geofence', margin_m: -3.2, action: 'rtl' };
    const html = render({
      fleet: [{ vehicleId: 'eis-1', status: 'on_mission', batteryPct: 81 }, { vehicleId: 'eis-2', status: 'idle', batteryPct: 40 }],
      selectedVehicle: 'eis-2',
      envelope,
      attendance: { type: 'mode', ts: 0, vehicleId: 'eis-2', mode: 'unattended', since: 0, operatorPresent: false },
      escalationCount: 3,
      undeliveredCount: 1,
      onExitUnattended: noop,
    });
    expect(html).toContain('aria-label="Select Drone"');
    expect(html).toContain('eis-1 · on mission · 81%');
    expect(html).toContain('BREACH');
    expect(html).toContain('geofence -3.2 m');
    expect(html).toContain('RTL');
    expect(html).toContain('UNATTENDED');
    expect(html).toContain('OPERATOR ABSENT');
    expect(html).toContain('Exit unattended');
    expect(html).toContain('OUTBOX 3');
    expect(html).toContain('1!');
  });
});

describe('ControlsPanel', () => {
  const render = (over: Partial<React.ComponentProps<typeof ControlsPanel>> = {}): string =>
    renderToStaticMarkup(
      React.createElement(ControlsPanel, {
        tel: null, tracking: null, connState: 'connected', standoff: 5, maxSpeed: 3,
        onCmd: noop, onSetStandoff: noop, onSetMaxSpeed: noop, onArm: noop, onTakeoff: noop, onEngage: noop,
        checklistDone: false, ...over,
      }),
    );

  it('starts with Arm, everything else disabled, and the checklist nag', () => {
    const html = render();
    expect(html).toContain('Arm');
    expect(html).not.toContain('Disarm');
    expect(buttonTagFor(html, 'Takeoff')).toContain('disabled');
    expect(buttonTagFor(html, 'Land')).toContain('disabled');
    expect(buttonTagFor(html, 'RTL')).toContain('disabled');
    expect(html).toContain('Pre-flight checklist required');
    expect(html).toContain('Take off first');
  });

  it('swaps Arm for Disarm and enables Takeoff once armed on the ground', () => {
    const html = render({ tel: telemetry({ armed: true }), checklistDone: true });
    expect(html).toContain('Disarm');
    expect(buttonTagFor(html, 'Takeoff')).not.toContain('disabled');
    expect(buttonTagFor(html, 'Land')).toContain('disabled');
    expect(html).not.toContain('Pre-flight checklist required');
  });

  it('enables Land, RTL and tracking engagement once airborne', () => {
    const html = render({ tel: telemetry({ armed: true, position: { lat: 1, lon: 2, relAlt: 8, absAlt: 30 } }), checklistDone: true });
    expect(buttonTagFor(html, 'Takeoff')).toContain('disabled');
    expect(buttonTagFor(html, 'Land')).not.toContain('disabled');
    expect(buttonTagFor(html, 'RTL')).not.toContain('disabled');
    expect(html).toContain('Engage Tracking');
    expect(html).toContain('Hold to engage');
  });

  it('marks the active mode chip and lists all five', () => {
    const html = render({ tel: telemetry({ mode: 'POSHOLD' }) });
    for (const m of ['LOITER', 'GUIDED', 'ALT_HOLD', 'POSHOLD', 'BRAKE']) expect(html).toContain(`>${m}</button>`);
    expect(buttonTagFor(html, '>POSHOLD</button>')).toContain('aria-pressed="true"');
    expect(buttonTagFor(html, '>LOITER</button>')).toContain('aria-pressed="false"');
  });

  it('offers an instant Disengage while tracking and names the state', () => {
    const tracking = { state: 'locked', targets: [], estimatedDistance: 4 } as unknown as TrackingStatus;
    const html = render({ tracking });
    expect(html).toContain('Disengage Tracking');
    expect(html).not.toContain('Engage Tracking');
    expect(html).toContain('locked');
  });

  it('keeps the gimbal readout', () => {
    expect(render()).toContain('no gimbal');
    expect(render({ tel: telemetry({ gimbal: { pitchDeg: 45 } }) })).toContain('45°');
    expect(render({ gimbalPitch: 85 })).toContain('straight down');
  });
});

describe('TelemetryPanel', () => {
  const render = (over: Partial<React.ComponentProps<typeof TelemetryPanel>> = {}): string =>
    renderToStaticMarkup(React.createElement(TelemetryPanel, { tel: null, tracking: null, history: { alt: [], bat: [] }, ...over }));

  it('renders zeros and dashes before telemetry', () => {
    const html = render();
    for (const label of ['Rel Alt', 'Ground Spd', 'Vert Spd', 'To Home', 'To Target', 'Battery', 'Sats', 'HDOP', 'Voltage', 'Lat', 'Lon', 'Altitude']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('—');
    expect(html).toContain('100');
  });

  it('shows the live numbers and the target range when locked', () => {
    const tracking = { state: 'locked', estimatedDistance: 4.2 } as unknown as TrackingStatus;
    const html = render({ tel: telemetry(), tracking, history: { alt: [0, 5, 10], bat: [90, 80, 22] } });
    expect(html).toContain('1.3');
    expect(html).toContain('37');
    expect(html).toContain('>4.2</span>');
    expect(html).toContain('22');
    expect(html).toContain('14');
    expect(html).toContain('0.9');
    expect(html).toContain('15.1V');
    expect(html).toContain('1.3521');
    expect(html).toContain('103.8198');
    expect(html).toContain('10.0 m');
    expect(html).toContain('22.0 %');
  });

  it('hides the target range unless locked', () => {
    const searching = { state: 'searching', estimatedDistance: 4.2 } as unknown as TrackingStatus;
    const html = render({ tel: telemetry(), tracking: searching });
    expect(html).not.toContain('>4.2</span>');
    expect(html).toContain('>—</span>');
  });
});

describe('LogConsole', () => {
  const entry = (severity: StatusText['severity'], text: string): StatusText => ({ type: 'statusText', ts: 0, vehicleId: 'eis-1', severity, text });
  const logs = [entry('info', 'Link up'), entry('warning', 'Wind gusting'), entry('critical', 'Geofence breach')];
  const render = (over: Partial<React.ComponentProps<typeof LogConsole>> = {}): string =>
    renderToStaticMarkup(React.createElement(LogConsole, { logs: [], recording: false, onToggleRecord: noop, ...over }));

  it('lists every entry with its tag and shows the count', () => {
    const html = render({ logs });
    expect(html).toContain('Link up');
    expect(html).toContain('Wind gusting');
    expect(html).toContain('Geofence breach');
    expect(html).toContain('INFO');
    expect(html).toContain('WARN');
    expect(html).toContain('CRIT');
    expect(html).toContain('>3<');
  });

  it('says so when there is nothing to show', () => {
    expect(render()).toContain('No events.');
  });

  it('toggles the record control label and only offers the browser when a host provides one', () => {
    expect(render()).toContain('Record');
    expect(render({ recording: true })).toContain('REC');
    expect(render()).not.toContain('Open log browser');
    expect(render({ onOpenBrowser: noop })).toContain('Open log browser');
  });
});
