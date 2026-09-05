/* ============================================================================
 * Eye in the Sky — Ground Control Center · App shell
 * ----------------------------------------------------------------------------
 * Faithful TS port of ui_kits/ground-control/GroundControl.jsx, wired to the
 * real DataSource seam (useDataSource) and the shared SettingsStore.
 *
 * Responsibilities:
 *   - Connect/disconnect the DataSource and subscribe to every stream
 *     (telemetry, tracking, statusText, ack, connection).
 *   - Hold all UI state: history/trail/flight-timer sampling, toasts, modals.
 *   - Drive the safety flows (checklist → arm, takeoff confirm, engage confirm,
 *     instant disarm/disengage) and manual (game-controller) engage/release.
 *   - Keyboard shortcuts (Space=disarm, T=engage, D=disengage, R=RTL).
 *   - Compose the full panel grid exactly as the prototype.
 *
 * The default export wraps the shell in <DataSourceProvider> so main.tsx can
 * render <App /> directly.
 * ========================================================================== */
import React, { useCallback, useEffect, useRef, useState } from 'react';

import type {
  Telemetry,
  TrackingStatus,
  StatusText,
  CommandAck,
  ConnectionState,
  ConnectionConfig,
  CommandName,
  Command,
  ManualInput,
} from '@/contract';

import { DataSourceProvider, useDataSource, useSettings } from '@/store';
import { dataSource } from '@/dataSource';

import { Toast } from '@/components';
import {
  StatusBar,
  ControlsPanel,
  ManualControl,
  TelemetryPanel,
  VideoPanel,
  MapPanel,
  LogConsole,
} from '@/panels';
import {
  ChecklistModal,
  TakeoffModal,
  SettingsModal,
  FailsafeModal,
  PidModal,
  LogBrowserModal,
  TrackingBanner,
  ManualBanner,
} from '@/views';

/* The drone's home / launch point. Matches the mock scene origin. */
const HOME = { lat: 37.7699, lon: -122.4666 };

/* Which modal (if any) is currently open. */
type ModalKind =
  | 'checklist'
  | 'takeoff'
  | 'settings'
  | 'failsafe'
  | 'pid'
  | 'logbrowser';

type ToastSeverity = 'info' | 'success' | 'warning' | 'error' | 'critical';
interface ToastItem {
  id: number;
  severity: ToastSeverity;
  title: string;
  message?: string;
}

/* SendCmd shape shared across panels (see contract). */
type SendCmd = (command: CommandName, params?: Command['params']) => void;

/* ----------------------------------------------------------------------------
 * In-memory flight recorder — the browser fallback used when the Electron
 * bridge (window.eis.recorder) is absent. While recording, every telemetry /
 * tracking / statusText frame is appended in memory. The Electron build swaps
 * this for the on-disk recorder transparently.
 * -------------------------------------------------------------------------- */
interface MemoryRecorder {
  start(): void;
  stop(): void;
  append(record: unknown): void;
  active(): boolean;
}
function createMemoryRecorder(): MemoryRecorder {
  let frames: unknown[] = [];
  let on = false;
  return {
    start() { frames = []; on = true; },
    stop() { on = false; },
    append(record) { if (on) frames.push(record); },
    active() { return on; },
  };
}
const memoryRecorder = createMemoryRecorder();

/* ========================================================================== */
function GroundControl(): JSX.Element {
  const ds = useDataSource();
  const settings = useSettings();

  const [tel, setTel] = useState<Telemetry | null>(null);
  const [tracking, setTracking] = useState<TrackingStatus | null>(null);
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [logs, setLogs] = useState<StatusText[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [history, setHistory] = useState<{ alt: number[]; bat: number[] }>({ alt: [], bat: [] });
  const [trail, setTrail] = useState<{ lat: number; lon: number }[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [recording, setRecording] = useState(false);

  const [standoff, setStandoff] = useState(4);
  const [maxSpeed, setMaxSpeed] = useState(3);
  const [checklistDone, setChecklistDone] = useState(false);
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [manualActive, setManualActive] = useState(false);
  const [controllerOn, setControllerOn] = useState(false);

  /* Connection config is owned by SettingsStore. The host shown in the status
     bar mirrors it; SITL collapses the host label to 'sitl'. */
  const config: ConnectionConfig = settings.connection;

  const pushToast = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Math.random();
    setToasts(ts => [...ts, { ...t, id }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), 4200);
  }, []);

  /* Keep a live recording flag for the sampling effect without re-subscribing. */
  const recordingRef = useRef(false);
  recordingRef.current = recording;

  /* Resolve the active recorder: Electron bridge first, in-memory fallback. */
  const appendFrame = useCallback((record: unknown) => {
    if (!recordingRef.current) return;
    const bridge = window.eis?.recorder;
    if (bridge) bridge.append(record);
    else memoryRecorder.append(record);
  }, []);

  /* ----- subscriptions: connect on mount, disconnect on unmount ----------- */
  useEffect(() => {
    let cancelled = false;
    ds.connect(config).catch(() => {
      if (!cancelled) setConnState('error');
    });

    const offC = ds.onConnectionChange(s => setConnState(s));
    const offT = ds.onTelemetry(t => { setTel(t); appendFrame(t); });
    const offK = ds.onTracking(t => { setTracking(t); appendFrame(t); });
    const offTxt = ds.onStatusText(s => {
      setLogs(l => [...l.slice(-200), s]);
      appendFrame(s);
      if (s.severity === 'critical') pushToast({ severity: 'critical', title: s.text });
    });
    const offAck = ds.onAck((a: CommandAck) => {
      if (!a.success) pushToast({ severity: 'error', title: `${a.command} failed`, message: a.message });
    });

    return () => {
      cancelled = true;
      offC(); offT(); offK(); offTxt(); offAck();
      ds.disconnect();
    };
    // Reconnect when the user changes connection in Settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, config.host, config.controlPort, config.videoUrl, config.sitl, appendFrame, pushToast]);

  /* ----- history + trail + flight-timer sampling (1 Hz) ------------------- */
  useEffect(() => {
    const id = setInterval(() => {
      setTel(cur => {
        if (cur) {
          setHistory(h => ({
            alt: [...h.alt.slice(-59), cur.position.relAlt],
            bat: [...h.bat.slice(-59), cur.battery.remaining],
          }));
          if (cur.position.relAlt > 0.4) {
            setTrail(tr => [...tr.slice(-120), { lat: cur.position.lat, lon: cur.position.lon }]);
          }
          if (cur.armed) setElapsed(e => e + 1);
        }
        return cur;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  /* ----- command helper --------------------------------------------------- */
  const cmd: SendCmd = useCallback(
    (command, params) => { void ds.sendCommand({ type: 'command', command, params }); },
    [ds],
  );

  /* ----- safety flows ----------------------------------------------------- */
  const doArm = () => {
    if (!checklistDone) { setModal('checklist'); return; }
    cmd('arm');
    pushToast({ severity: 'success', title: 'Armed' });
  };
  const doTakeoff = () => setModal('takeoff');
  const confirmTakeoff = (alt: number) => {
    cmd('takeoff', { altitude: alt });
    setModal(null);
    pushToast({ severity: 'success', title: 'Takeoff acknowledged', message: `Climbing to ${alt} m` });
  };
  const doEngage = () => {
    setManualActive(false);
    cmd('engageTracking');
    cmd('setStandoff', { meters: standoff });
    cmd('setMaxSpeed', { mps: maxSpeed });
    pushToast({ severity: 'warning', title: 'Tracking engaged', message: `Standoff ${standoff} m` });
  };
  const doDisarm = () => {
    setManualActive(false);
    cmd('emergencyStop');
    pushToast({ severity: 'error', title: 'Disarmed' });
  };

  const onStandoff = (v: number) => { setStandoff(v); cmd('setStandoff', { meters: v }); };
  const onMaxSpeed = (v: number) => { setMaxSpeed(v); cmd('setMaxSpeed', { mps: v }); };

  /* ----- manual (game-controller) piloting -------------------------------- */
  const doManualEngage = () => {
    cmd('engageManual');
    setManualActive(true);
    pushToast({ severity: 'warning', title: 'Manual control engaged', message: 'Operator has the sticks' });
  };
  const doManualRelease = () => {
    cmd('disengageManual');
    setManualActive(false);
    pushToast({ severity: 'info', title: 'Manual released', message: 'Position hold' });
  };
  const onStickInput = useCallback((v: ManualInput) => ds.setManualInput(v), [ds]);

  /* ----- recording toggle ------------------------------------------------- */
  const onToggleRecord = useCallback(() => {
    setRecording(r => {
      const next = !r;
      const bridge = window.eis?.recorder;
      if (next) { if (bridge) void bridge.start(); else memoryRecorder.start(); }
      else { if (bridge) void bridge.stop(); else memoryRecorder.stop(); }
      return next;
    });
  }, []);

  /* ----- keyboard shortcuts ----------------------------------------------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); doDisarm(); }
      else if (e.key === 't' || e.key === 'T') {
        if (tracking?.state === 'idle' && (tel?.position?.relAlt ?? 0) > 0.5) doEngage();
      }
      else if (e.key === 'd' || e.key === 'D') {
        if (tracking && tracking.state !== 'idle') cmd('disengageTracking');
      }
      else if (e.key === 'r' || e.key === 'R') {
        if ((tel?.position?.relAlt ?? 0) > 0.5) cmd('rtl');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const trackingActive = !!tracking && tracking.state !== 'idle';
  const flying = (tel?.position?.relAlt ?? 0) > 0.5;
  const hostLabel = config.sitl ? 'sitl' : config.host;

  /* ----- power management (Linux only) ------------------------------------
   * Keep the display awake while the vehicle is armed or tracking/manual is
   * active (LINUX_PRD §7). window.eis.power exists only in the Linux Electron
   * shell; on the Windows shell and the browser dev server it's undefined and
   * this whole effect is a no-op. */
  const powerInhibitedRef = useRef(false);
  useEffect(() => {
    const power = window.eis?.power;
    if (!power) return;
    const shouldInhibit = !!tel?.armed || manualActive || trackingActive;
    if (shouldInhibit === powerInhibitedRef.current) return;
    powerInhibitedRef.current = shouldInhibit;
    if (shouldInhibit) void power.inhibit();
    else void power.release();
  }, [tel?.armed, manualActive, trackingActive]);

  return (
    <div
      className="eis-root"
      style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-app)', overflow: 'hidden' }}
    >
      <StatusBar
        tel={tel}
        connState={connState}
        sitl={config.sitl}
        host={hostLabel}
        elapsed={elapsed}
        controllerOn={controllerOn}
        manualActive={manualActive}
        onDisarm={doDisarm}
        onOpenSettings={() => setModal('settings')}
        onOpenFailsafe={() => setModal('failsafe')}
        onOpenPid={() => setModal('pid')}
        onOpenLogs={() => setModal('logbrowser')}
      />

      {trackingActive && (
        <TrackingBanner standoff={standoff} maxSpeed={maxSpeed} onDisengage={() => cmd('disengageTracking')} />
      )}
      {manualActive && <ManualBanner onRelease={doManualRelease} />}

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'var(--leftpanel-w) 1fr var(--rightpanel-w)', gap: 10, padding: 10 }}>
        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'auto', paddingRight: 2 }}>
          <ControlsPanel
            tel={tel}
            tracking={tracking}
            connState={connState}
            standoff={standoff}
            maxSpeed={maxSpeed}
            onCmd={cmd}
            onSetStandoff={onStandoff}
            onSetMaxSpeed={onMaxSpeed}
            onArm={doArm}
            onTakeoff={doTakeoff}
            onEngage={doEngage}
            checklistDone={checklistDone}
          />
          <ManualControl
            armed={!!tel?.armed}
            flying={flying}
            manualActive={manualActive}
            onEngage={doManualEngage}
            onRelease={doManualRelease}
            onInput={onStickInput}
            onControllerChange={setControllerOn}
          />
        </div>

        {/* CENTER */}
        <div style={{ display: 'grid', gridTemplateRows: '1.55fr 1fr', gap: 10, minHeight: 0 }}>
          <div style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--border-default)', minHeight: 0 }}>
            <VideoPanel
              tracking={tracking}
              connState={connState}
              standoff={standoff}
              onSelectTarget={(id: number) => cmd('selectTarget', { targetId: id })}
              videoUrl={ds.getVideoUrl()}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 10, minHeight: 0 }}>
            <MapPanel
              tel={tel}
              tracking={tracking}
              home={HOME}
              trail={trail}
              geofenceRadius={settings.failsafe.geofenceRadius}
            />
            <LogConsole
              logs={logs}
              recording={recording}
              onToggleRecord={onToggleRecord}
              onOpenBrowser={() => setModal('logbrowser')}
            />
          </div>
        </div>

        {/* RIGHT */}
        <TelemetryPanel tel={tel} tracking={tracking} history={history} />
      </div>

      {/* toasts */}
      <div style={{ position: 'fixed', top: 56, right: 14, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 1200 }}>
        {toasts.map(t => (
          <Toast
            key={t.id}
            severity={t.severity}
            title={t.title}
            message={t.message}
            onDismiss={() => setToasts(ts => ts.filter(x => x.id !== t.id))}
          />
        ))}
      </div>

      {/* modals */}
      <ChecklistModal
        open={modal === 'checklist'}
        onClose={() => setModal(null)}
        onComplete={() => {
          setChecklistDone(true);
          setModal(null);
          cmd('arm');
          pushToast({ severity: 'success', title: 'Checklist complete — Armed' });
        }}
      />
      <TakeoffModal open={modal === 'takeoff'} onClose={() => setModal(null)} onConfirm={confirmTakeoff} defaultAlt={4} />
      <SettingsModal open={modal === 'settings'} onClose={() => setModal(null)} />
      <FailsafeModal open={modal === 'failsafe'} onClose={() => setModal(null)} />
      <PidModal open={modal === 'pid'} onClose={() => setModal(null)} />
      <LogBrowserModal open={modal === 'logbrowser'} onClose={() => setModal(null)} />
    </div>
  );
}

/* The default export wires the DataSource singleton into context so the rest of
   the tree (and the shell above) can call useDataSource(). To go LIVE, the only
   change is in src/dataSource/index.ts — see README. */
export default function App(): JSX.Element {
  return (
    <DataSourceProvider source={dataSource}>
      <GroundControl />
    </DataSourceProvider>
  );
}
