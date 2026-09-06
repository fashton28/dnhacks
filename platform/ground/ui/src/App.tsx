/* ============================================================================
 * Drone Safety Platform — Ground Control Center · App shell
 * ----------------------------------------------------------------------------
 * The one component that owns the DataSource seam (useDataSource) and the
 * shared SettingsStore, and composes the panel grid. Everything that is not
 * composition lives in a hook with a single job:
 *
 *   useToastQueue         transient operator notices with a fixed lifetime
 *   useFlightRecorder     telemetry/tracking/status frames → Electron recorder
 *                         or the in-memory fallback
 *   useFlightSampler      1 Hz altitude/battery history, breadcrumb trail and
 *                         the flight timer, sampled from the latest telemetry
 *   useModalRouter        which modal (if any) is open
 *   useCommandSender      the fire-and-forget `command` envelope for a vehicle
 *   useOperatorFlows      the safety flows: checklist → arm, takeoff confirm,
 *                         engage confirm, instant disarm, manual engage/release
 *   useKeyboardShortcuts  Space=disarm, T=engage, D=disengage, R=RTL
 *   useDisplayWakeLock    keep the display awake while the vehicle is active
 *
 * The default export wraps the shell in <DataSourceProvider> so main.tsx can
 * render <App /> directly.
 * ========================================================================== */
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';

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
  HealthEventMessage,
  ObservationMessage,
  ReadinessMessage,
  RfEventMessage,
  SensorHealth,
  SimulationToggles,
  SpectrumMessage,
  CapabilitiesMessage,
  Anomaly,
  Unsubscribe,
} from '@/contract';
import { DEFAULT_VEHICLE_ID } from '@/contract';

import {
  DataSourceProvider,
  useDataSource,
  useSettings,
  useMission,
  missionStore,
  effectivePlan,
  envelopeOf,
} from '@/store';
import type { PlanProposal, ReportResolution } from '@/store';
import { dataSource, isHubMode, consoleUrl, fleetCapable } from '@/dataSource';
import type { DemoScenario, FleetRow, MissionDataSource } from '@/dataSource';
import { getSiteModel } from '@/site';
import type { SiteModel } from '@/site';
import type { RailHealth } from '@/cues';
import { windContext } from '@/lib/wind';

import { Toast, Tabs, Badge, Button } from '@/components';
import {
  StatusBar,
  ControlsPanel,
  ManualControl,
  TelemetryPanel,
  VideoPanel,
  MapPanel,
  LogConsole,
  MissionMap,
  SatellitePanel,
  VerifierPanel,
  ReportPanel,
  AuditLogPanel,
  MissionStatusStrip,
  ObservationPanel,
  SimulationPanel,
  TaskPlanPanel,
} from '@/panels';
import type { ReportTab } from '@/panels';
import {
  ChecklistModal,
  TakeoffModal,
  SettingsModal,
  FailsafeModal,
  PidModal,
  LogBrowserModal,
  TrackingBanner,
  ManualBanner,
  PlannerBanner,
  UnattendedModal,
} from '@/views';
import type { VerificationContext } from '@planner/verifier';
import type { ObservationSummary } from '@planner/report';
import { pointInPolygon } from '@planner/site';
import bakedAnomalies from '@satdata/anomalies.json';

/* Pre-site fallback home / launch point (matches the mock scene origin before
   the site model loads). Once the site JSON is loaded, its home is used —
   plant geometry is never hardcoded (docs/SITE_CONTRACT.md). */
const FALLBACK_HOME = { lat: 37.7699, lon: -122.4666 };

/**
 * How long an RF report stays part of the CURRENT airspace picture, ms.
 * Mirrors `RF_POLICY.eventWindowS` in ground/planner and the 60 s correlation
 * window in `rf_adapter`. The panel list was bounded by COUNT alone, so one
 * hostile-drone report early in a session stayed on screen — and in the
 * verifier's context — for the rest of it (FM-51).
 */
const RF_EVENT_WINDOW_MS = 60_000;

/* ---- shell tunables ------------------------------------------------------ */

/** How long a toast stays on screen, ms. */
const TOAST_TTL_MS = 4200;
/** History / trail / flight-timer sampling period, ms. */
const SAMPLE_PERIOD_MS = 1000;
/** Altitude and battery samples kept for the sparklines. */
const HISTORY_SAMPLES = 60;
/** Breadcrumb points kept on the map. */
const TRAIL_POINTS = 120;
/** Below this altitude the vehicle is on the pad and leaves no breadcrumb. */
const TRAIL_MIN_ALT_M = 0.4;
/** The airborne gate for engage / RTL. */
const AIRBORNE_MIN_ALT_M = 0.5;
/** Status lines kept in the console. */
const LOG_LINES = 200;
/** Altitude the takeoff dialog proposes, m. */
const DEFAULT_TAKEOFF_ALT_M = 4;

/* Center-column view: classic flight ops, the mission (security) workspace, or the ARGUS 3D World view. */
type CenterView = 'flight' | 'mission' | 'world';

const DEFAULT_SIMULATION_TOGGLES: SimulationToggles = {
  simulateGpsLoss: false, simulateRfInterference: false, simulateHostileDrone: false,
  simulateLinkLoss: false, simulateCameraFail: false, simulateCharging: false,
  simulateBatteryFault: false, simulateSortieExpiry: false, simulateThermalFail: false,
  simulateLidarFail: false, simulateNight: false,
};

function liveDemoAnomaly(site: SiteModel): Anomaly {
  const baked = (bakedAnomalies as Anomaly[])[0];
  if (baked && pointInPolygon(baked, site.perimeter)) return baked;
  const staging = site.staging[0];
  return {
    ...(baked ?? { id: 'sat-change-1', type: 'change', confidence: 0.9, thumbnail: '', source: 'sentinel2' as const }),
    lat: staging?.lat ?? site.home.lat,
    lon: staging?.lon ?? site.home.lon,
  };
}

/* Which modal (if any) is currently open. */
type ModalKind =
  | 'checklist'
  | 'takeoff'
  | 'settings'
  | 'failsafe'
  | 'pid'
  | 'logbrowser'
  | 'unattended';

/** Right-hand column of the mission workspace: observation vs cue provenance.
 *  Tabs rather than panels — the five-panel discipline holds. */
type SideView = 'observation' | 'cues';

type ToastSeverity = 'info' | 'success' | 'warning' | 'error' | 'critical';
interface ToastItem {
  id: number;
  severity: ToastSeverity;
  title: string;
  message?: string;
}
type PushToast = (toast: Omit<ToastItem, 'id'>) => void;

/* SendCmd shape shared across panels (see contract). */
type SendCmd = (command: CommandName, params?: Command['params']) => void;

type LatLon = { lat: number; lon: number };

/** Append `item`, keeping at most `max` entries (the oldest fall off). */
function pushBounded<T>(list: T[], item: T, max: number): T[] {
  const kept = list.length >= max ? list.slice(list.length - max + 1) : list;
  return [...kept, item];
}

/* ============================================================================
 * Toasts — a queue with a fixed lifetime per entry. Ids are monotonic so a
 * dismissed toast can never collide with a new one; expiry timers are owned
 * by the hook and cleared when the shell unmounts.
 * ========================================================================== */
type ToastAction = { kind: 'push'; toast: ToastItem } | { kind: 'dismiss'; id: number };

function toastReducer(list: ToastItem[], action: ToastAction): ToastItem[] {
  switch (action.kind) {
    case 'push':
      return [...list, action.toast];
    case 'dismiss':
      return list.filter((t) => t.id !== action.id);
  }
}

function useToastQueue(ttlMs = TOAST_TTL_MS): {
  toasts: ToastItem[];
  pushToast: PushToast;
  dismissToast: (id: number) => void;
} {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismissToast = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    dispatch({ kind: 'dismiss', id });
  }, []);

  const pushToast = useCallback<PushToast>((toast) => {
    const id = nextId.current;
    nextId.current += 1;
    dispatch({ kind: 'push', toast: { ...toast, id } });
    timers.current.set(id, setTimeout(() => dismissToast(id), ttlMs));
  }, [dismissToast, ttlMs]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  return { toasts, pushToast, dismissToast };
}

/* ============================================================================
 * Flight recorder — the Electron bridge (window.eis.recorder) when present,
 * otherwise an in-memory sink. While recording, every telemetry / tracking /
 * statusText / mission frame is appended; the active sink is a ref so the
 * subscription handlers never re-subscribe when recording toggles.
 * ========================================================================== */
interface RecorderSink {
  append(record: unknown): void;
}

class MemoryFlightRecorder implements RecorderSink {
  private frames: unknown[] = [];
  private live = false;

  start(): void {
    this.frames = [];
    this.live = true;
  }
  stop(): void {
    this.live = false;
  }
  append(record: unknown): void {
    if (this.live) this.frames.push(record);
  }
  active(): boolean {
    return this.live;
  }
  count(): number {
    return this.frames.length;
  }
}
const memoryRecorder = new MemoryFlightRecorder();

function useFlightRecorder(): {
  recording: boolean;
  toggleRecording: () => void;
  appendFrame: (record: unknown) => void;
} {
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const sinkRef = useRef<RecorderSink | null>(null);

  const appendFrame = useCallback((record: unknown) => {
    sinkRef.current?.append(record);
  }, []);

  const toggleRecording = useCallback(() => {
    const next = !recordingRef.current;
    recordingRef.current = next;
    const bridge = window.eis?.recorder;
    if (next) {
      if (bridge) {
        void bridge.start();
        sinkRef.current = bridge;
      } else {
        memoryRecorder.start();
        sinkRef.current = memoryRecorder;
      }
    } else {
      sinkRef.current = null;
      if (bridge) void bridge.stop();
      else memoryRecorder.stop();
    }
    setRecording(next);
  }, []);

  return { recording, toggleRecording, appendFrame };
}

/* ============================================================================
 * Flight sampler — once a second, the latest telemetry frame contributes an
 * altitude and battery sample, a breadcrumb (only once airborne) and one
 * second on the flight timer (only while armed). Switching vehicles resets
 * the history and the trail; the timer keeps counting.
 * ========================================================================== */
interface FlightSamples {
  history: { alt: number[]; bat: number[] };
  trail: LatLon[];
  elapsed: number;
}
type SampleAction = { kind: 'sample'; tel: Telemetry } | { kind: 'reset' };

const EMPTY_SAMPLES: FlightSamples = { history: { alt: [], bat: [] }, trail: [], elapsed: 0 };

function samplesReducer(state: FlightSamples, action: SampleAction): FlightSamples {
  if (action.kind === 'reset') return { ...EMPTY_SAMPLES, elapsed: state.elapsed };
  const { tel } = action;
  const airborne = tel.position.relAlt > TRAIL_MIN_ALT_M;
  return {
    history: {
      alt: pushBounded(state.history.alt, tel.position.relAlt, HISTORY_SAMPLES),
      bat: pushBounded(state.history.bat, tel.battery.remaining, HISTORY_SAMPLES),
    },
    trail: airborne
      ? pushBounded(state.trail, { lat: tel.position.lat, lon: tel.position.lon }, TRAIL_POINTS)
      : state.trail,
    elapsed: tel.armed ? state.elapsed + 1 : state.elapsed,
  };
}

function useFlightSampler(latest: React.MutableRefObject<Telemetry | null>): FlightSamples & {
  resetSamples: () => void;
} {
  const [samples, dispatch] = useReducer(samplesReducer, EMPTY_SAMPLES);
  useEffect(() => {
    const id = setInterval(() => {
      const tel = latest.current;
      if (tel) dispatch({ kind: 'sample', tel });
    }, SAMPLE_PERIOD_MS);
    return () => clearInterval(id);
  }, [latest]);
  const resetSamples = useCallback(() => dispatch({ kind: 'reset' }), []);
  return { ...samples, resetSamples };
}

/* ============================================================================
 * Modal router — at most one modal is open.
 * ========================================================================== */
function useModalRouter(): {
  modal: ModalKind | null;
  openModal: (kind: ModalKind) => void;
  closeModal: () => void;
} {
  const [modal, setModal] = useState<ModalKind | null>(null);
  const openModal = useCallback((kind: ModalKind) => setModal(kind), []);
  const closeModal = useCallback(() => setModal(null), []);
  return { modal, openModal, closeModal };
}

/* ============================================================================
 * Command sender — the `command` envelope for the vehicle being followed.
 * Fire-and-forget: acks arrive on the ack channel and failures toast there.
 * ========================================================================== */
function useCommandSender(ds: MissionDataSource, vehicleId: string): SendCmd {
  return useCallback<SendCmd>((command, params) => {
    void ds.sendCommand({ type: 'command', vehicleId, command, params });
  }, [ds, vehicleId]);
}

/* ============================================================================
 * Operator flows — the safety-relevant operator actions and the local state
 * they read. Arming is gated by the pre-flight checklist; takeoff needs an
 * explicit altitude confirmation; engaging tracking pushes the current
 * standoff and speed cap with it; disarm is instant and always available.
 * ========================================================================== */
interface OperatorFlowState {
  checklistDone: boolean;
  standoff: number;
  maxSpeed: number;
  manualActive: boolean;
}
type OperatorFlowAction =
  | { kind: 'checklist' }
  | { kind: 'standoff'; meters: number }
  | { kind: 'maxSpeed'; mps: number }
  | { kind: 'manual'; active: boolean };

const INITIAL_FLOWS: OperatorFlowState = { checklistDone: false, standoff: 4, maxSpeed: 3, manualActive: false };

function operatorFlowReducer(state: OperatorFlowState, action: OperatorFlowAction): OperatorFlowState {
  switch (action.kind) {
    case 'checklist':
      return state.checklistDone ? state : { ...state, checklistDone: true };
    case 'standoff':
      return { ...state, standoff: action.meters };
    case 'maxSpeed':
      return { ...state, maxSpeed: action.mps };
    case 'manual':
      return state.manualActive === action.active ? state : { ...state, manualActive: action.active };
  }
}

function useOperatorFlows(
  cmd: SendCmd,
  pushToast: PushToast,
  openModal: (kind: ModalKind) => void,
  closeModal: () => void,
): OperatorFlowState & {
  setManualActive: (active: boolean) => void;
  arm: () => void;
  completeChecklist: () => void;
  requestTakeoff: () => void;
  confirmTakeoff: (alt: number) => void;
  engageTracking: () => void;
  disarm: () => void;
  setStandoff: (meters: number) => void;
  setMaxSpeed: (mps: number) => void;
  engageManual: () => void;
  releaseManual: () => void;
} {
  const [state, dispatch] = useReducer(operatorFlowReducer, INITIAL_FLOWS);
  const { checklistDone, standoff, maxSpeed } = state;

  const setManualActive = useCallback((active: boolean) => dispatch({ kind: 'manual', active }), []);

  /* The first arm request opens the checklist; completing it arms. */
  const arm = useCallback(() => {
    if (!checklistDone) {
      openModal('checklist');
      return;
    }
    cmd('arm');
    pushToast({ severity: 'success', title: 'Armed' });
  }, [checklistDone, cmd, pushToast, openModal]);

  const completeChecklist = useCallback(() => {
    dispatch({ kind: 'checklist' });
    closeModal();
    cmd('arm');
    pushToast({ severity: 'success', title: 'Checklist complete — Armed' });
  }, [cmd, pushToast, closeModal]);

  const requestTakeoff = useCallback(() => openModal('takeoff'), [openModal]);

  const confirmTakeoff = useCallback((alt: number) => {
    cmd('takeoff', { altitude: alt });
    closeModal();
    pushToast({ severity: 'success', title: 'Takeoff acknowledged', message: `Climbing to ${alt} m` });
  }, [cmd, pushToast, closeModal]);

  /* Engaging tracking hands the vehicle to the tracker with the operator's
     current standoff and speed cap; manual is released locally first because
     exactly one controlSource is ever active. */
  const engageTracking = useCallback(() => {
    setManualActive(false);
    cmd('engageTracking');
    cmd('setStandoff', { meters: standoff });
    cmd('setMaxSpeed', { mps: maxSpeed });
    pushToast({ severity: 'warning', title: 'Tracking engaged', message: `Standoff ${standoff} m` });
  }, [cmd, pushToast, setManualActive, standoff, maxSpeed]);

  /* Disarm is the emergency stop: no confirmation, no gate. */
  const disarm = useCallback(() => {
    setManualActive(false);
    cmd('emergencyStop');
    pushToast({ severity: 'error', title: 'Disarmed' });
  }, [cmd, pushToast, setManualActive]);

  const setStandoff = useCallback((meters: number) => {
    dispatch({ kind: 'standoff', meters });
    cmd('setStandoff', { meters });
  }, [cmd]);

  const setMaxSpeed = useCallback((mps: number) => {
    dispatch({ kind: 'maxSpeed', mps });
    cmd('setMaxSpeed', { mps });
  }, [cmd]);

  const engageManual = useCallback(() => {
    cmd('engageManual');
    setManualActive(true);
    pushToast({ severity: 'warning', title: 'Manual control engaged', message: 'Operator has the sticks' });
  }, [cmd, pushToast, setManualActive]);

  const releaseManual = useCallback(() => {
    cmd('disengageManual');
    setManualActive(false);
    pushToast({ severity: 'info', title: 'Manual released', message: 'Position hold' });
  }, [cmd, pushToast, setManualActive]);

  return {
    ...state,
    setManualActive,
    arm,
    completeChecklist,
    requestTakeoff,
    confirmTakeoff,
    engageTracking,
    disarm,
    setStandoff,
    setMaxSpeed,
    engageManual,
    releaseManual,
  };
}

/* ============================================================================
 * Keyboard shortcuts — a key → action table. The listener is registered once
 * and reads the latest table through a ref, so the handlers always see the
 * current flight state without re-subscribing every render. Keystrokes while
 * typing in a field are ignored, as are auto-repeats.
 * ========================================================================== */
interface Shortcut {
  /** Guard evaluated at keypress; the action runs only when it holds. */
  when?: () => boolean;
  run: () => void;
  preventDefault?: boolean;
}
type ShortcutTable = Record<string, Shortcut>;

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function shortcutKey(e: KeyboardEvent): string {
  if (e.code === 'Space') return 'space';
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (EDITABLE_TAGS.has(el.tagName) || el.isContentEditable === true);
}

function useKeyboardShortcuts(table: ShortcutTable): void {
  const latest = useRef(table);
  latest.current = table;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || isTypingTarget(e.target)) return;
      const shortcut = latest.current[shortcutKey(e)];
      if (!shortcut) return;
      if (shortcut.preventDefault) e.preventDefault();
      if (shortcut.when && !shortcut.when()) return;
      shortcut.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/* ============================================================================
 * Display wake lock (Linux only) — keep the display awake while the vehicle
 * is armed or tracking/manual/planner is active (LINUX_PRD §7).
 * window.eis.power exists only in the Linux Electron shell; on the Windows
 * shell and the browser dev server it's undefined and this is a no-op.
 * ========================================================================== */
function useDisplayWakeLock(shouldInhibit: boolean): void {
  const inhibited = useRef(false);
  useEffect(() => {
    const power = window.eis?.power;
    if (!power || inhibited.current === shouldInhibit) return;
    inhibited.current = shouldInhibit;
    void (shouldInhibit ? power.inhibit() : power.release());
  }, [shouldInhibit]);
  useEffect(() => () => {
    if (inhibited.current) void window.eis?.power?.release();
  }, []);
}

/* ============================================================================
 * Presentational helpers for the shell.
 * ========================================================================== */
function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }): JSX.Element {
  return (
    <div style={{ position: 'fixed', top: 56, right: 14, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 1200 }}>
      {toasts.map((t) => (
        <Toast
          key={t.id}
          severity={t.severity}
          title={t.title}
          message={t.message}
          onDismiss={() => onDismiss(t.id)}
        />
      ))}
    </div>
  );
}

interface ModalHostProps {
  modal: ModalKind | null;
  onClose: () => void;
  onChecklistComplete: () => void;
  onConfirmTakeoff: (alt: number) => void;
  onEnterUnattended: (operatorId: string) => void;
  operatorId: string;
}

function ModalHost(p: ModalHostProps): JSX.Element {
  return (
    <>
      <ChecklistModal open={p.modal === 'checklist'} onClose={p.onClose} onComplete={p.onChecklistComplete} />
      <TakeoffModal open={p.modal === 'takeoff'} onClose={p.onClose} onConfirm={p.onConfirmTakeoff} defaultAlt={DEFAULT_TAKEOFF_ALT_M} />
      <SettingsModal open={p.modal === 'settings'} onClose={p.onClose} />
      <FailsafeModal open={p.modal === 'failsafe'} onClose={p.onClose} />
      <PidModal open={p.modal === 'pid'} onClose={p.onClose} />
      <LogBrowserModal open={p.modal === 'logbrowser'} onClose={p.onClose} />
      <UnattendedModal
        open={p.modal === 'unattended'}
        onClose={p.onClose}
        onConfirm={p.onEnterUnattended}
        defaultOperatorId={p.operatorId}
      />
    </>
  );
}

/* ========================================================================== */
function GroundControl(): JSX.Element {
  const ds = useDataSource();
  const settings = useSettings();

  const [tel, setTel] = useState<Telemetry | null>(null);
  const latestTel = useRef<Telemetry | null>(null);
  const [tracking, setTracking] = useState<TrackingStatus | null>(null);
  const [connState, setConnState] = useState<ConnectionState>('connecting');
  const [logs, setLogs] = useState<StatusText[]>([]);
  const [observation, setObservation] = useState<ObservationMessage | null>(null);
  const [readiness, setReadiness] = useState<ReadinessMessage | null>(null);
  const [health, setHealth] = useState<Partial<Record<HealthEventMessage['component'], HealthEventMessage>>>({});
  const [rfEvents, setRfEvents] = useState<RfEventMessage[]>([]);
  const [spectrum, setSpectrum] = useState<SpectrumMessage | null>(null);
  /** Per-rail cue badges (FM-180); empty on a provider that hosts no rails. */
  const [railHealth, setRailHealth] = useState<RailHealth[]>([]);
  const [capabilities, setCapabilities] = useState<CapabilitiesMessage | null>(null);
  const [livePlanning, setLivePlanning] = useState(false);
  const [simulationToggles, setSimulationToggles] = useState<SimulationToggles>(() => ({
    ...DEFAULT_SIMULATION_TOGGLES,
    ...ds.getSimulationToggles?.(),
  }));

  const [controllerOn, setControllerOn] = useState(false);
  const [centerView, setCenterView] = useState<CenterView>('flight');
  const [sideView, setSideView] = useState<SideView>('observation');
  const [reportTab, setReportTab] = useState<ReportTab>('report');
  const [fleet, setFleet] = useState<FleetRow[]>([]);
  const [vehicleId, setVehicleId] = useState<string>(DEFAULT_VEHICLE_ID);
  const [gimbalPitch, setGimbalPitch] = useState(45);
  const [operatorId, setOperatorId] = useState('');
  /** Per-vehicle breadcrumb tracks, sampled from the fleet stream. */
  const [trailsByVehicle, setTrailsByVehicle] =
    useState<Record<string, { lat: number; lon: number }[]>>({});

  const { toasts, pushToast, dismissToast } = useToastQueue();
  const { recording, toggleRecording, appendFrame } = useFlightRecorder();
  const { history, trail, elapsed, resetSamples } = useFlightSampler(latestTel);
  const { modal, openModal, closeModal } = useModalRouter();
  const cmd = useCommandSender(ds, vehicleId);
  const flows = useOperatorFlows(cmd, pushToast, openModal, closeModal);

  /* Mission (anomaly → plan → verification → report) state + audit trail. */
  const mission = useMission();
  const autoSwitchedRef = useRef(false);
  const reportingRef = useRef(new Set<string>());

  /* The live-inspection gate. The ref is the re-entrancy guard (a ref is read
     synchronously, so two fast clicks cannot both pass it); the state is what
     the button renders from, so clearing the latch actually re-enables it.
     Before FM-81 this was a ref alone, set BEFORE the planner call and cleared
     only in `catch`, so a resolved-but-rejected proposal latched the button
     off for the life of the process. */
  const liveStartedRef = useRef(false);
  const [inspectionPlanned, setInspectionPlanned] = useState(false);
  const setInspectionLatch = useCallback((value: boolean) => {
    liveStartedRef.current = value;
    setInspectionPlanned(value);
  }, []);

  /* Connection config is owned by SettingsStore. The host shown in the status
     bar mirrors it; SITL collapses the host label to 'sitl'. */
  const config: ConnectionConfig = settings.connection;
  const [activeConfig, setActiveConfig] = useState<ConnectionConfig>(config);

  /* ----- site model: load once, feed the mission store -------------------- */
  useEffect(() => {
    getSiteModel()
      .then((site) => missionStore.setSite(site))
      .catch((err: unknown) => {
        pushToast({ severity: 'error', title: 'Site model failed to load', message: (err as Error).message });
      });
  }, [pushToast]);

  /* ----- subscriptions: connect on mount, disconnect on unmount ----------- */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let selected = config;
      if (ds.kind === 'live' && window.eis?.defaultConfig) {
        try {
          selected = { ...config, ...(await window.eis.defaultConfig()) };
        } catch { /* retain the user's stored connection */ }
      }
      if (cancelled) return;
      setActiveConfig(selected);
      await ds.connect(selected);
    })().catch(() => { if (!cancelled) setConnState('error'); });

    /* Every stream subscription is collected so teardown is one loop. */
    const subscriptions: Unsubscribe[] = [];
    const on = (off: Unsubscribe): void => { subscriptions.push(off); };

    on(ds.onConnectionChange((s) => setConnState(s)));
    on(ds.onTelemetry((t) => {
      latestTel.current = t;
      setTel(t);
      appendFrame(t);
      missionStore.noteControlSource(t.controlSource, t.vehicleId);
    }));
    on(ds.onTracking((t) => { setTracking(t); appendFrame(t); }));
    on(ds.onStatusText((s) => {
      setLogs((lines) => pushBounded(lines, s, LOG_LINES));
      appendFrame(s);
      // While a mission executes, status lines (waypoints, observation, RTL)
      // belong in the mission audit trail too.
      if (missionStore.get().executing) missionStore.addAudit('status', s.text, s.vehicleId);
      if (s.severity === 'critical') pushToast({ severity: 'critical', title: s.text });
    }));
    on(ds.onAck((a: CommandAck) => {
      if (!a.success) pushToast({ severity: 'error', title: `${a.command} failed`, message: a.message });
    }));
    if (fleetCapable(ds)) {
      on(ds.onFleetRows((rows) => { setFleet(rows); setVehicleId(ds.getVehicle()); }));
    }

    /* mission channels (anomaly → plan → verification → incident report) */
    on(ds.onAnomaly(m => {
      missionStore.ingestAnomaly(m.anomaly, m.vehicleId);
      appendFrame(m);
      if (ds.railHealth) setRailHealth(ds.railHealth());
      pushToast({ severity: 'warning', title: `${m.anomaly.source} cue detected`, message: m.anomaly.id });
      if (!autoSwitchedRef.current) {
        autoSwitchedRef.current = true;
        setCenterView('mission');
      }
    }));
    on(ds.onMissionPlan(m => { missionStore.ingestPlan(m.plan, m.vehicleId); appendFrame(m); }));
    on(ds.onVerification(m => {
      missionStore.ingestVerification(m.verification, m.vehicleId); appendFrame(m);
    }));
    on(ds.onIncidentReport(m => {
      missionStore.ingestReport(m.report, m.vehicleId);
      appendFrame(m);
      pushToast({
        severity: m.report.verdict === 'escalate' ? 'critical' : 'info',
        title: `Incident report: ${m.report.verdict.replace('_', ' ')}`,
        message: m.report.missionId,
      });
    }));
    on(ds.onObservation(m => {
      setObservation(m);
      appendFrame(m);
      missionStore.addAudit('observation', `Observation ${m.scene}: ${m.tracks.length} track(s), RGB ${m.sensors.rgb}, thermal ${m.sensors.thermal}, LiDAR ${m.sensors.lidar}`, m.vehicleId);
      const reportService = window.eis?.plannerReport;
      if (ds.kind === 'live' && reportService) {
        const state = missionStore.get();
        const requestId = m.missionId ?? state.executedRequestId;
        const proposal = requestId
          ? state.proposals.find((candidate) => candidate.plan.requestId === requestId)
          : undefined;
        const anomaly = proposal
          ? state.anomalies.find((candidate) => candidate.id === proposal.plan.anomalyId)
          : undefined;
        if (requestId && proposal && anomaly && !reportingRef.current.has(requestId)) {
          reportingRef.current.add(requestId);
          const reviewable = m.sensors.rgb !== 'failed' && m.sensors.thermal !== 'failed' &&
            !!m.frames?.rgb && !!m.frames?.thermal;
          const confidence = m.tracks.length > 0
            ? Math.max(...m.tracks.map((track) => track.conf))
            : reviewable ? 0.9 : 0;
          const summary: ObservationSummary = {
            detected: m.tracks.length > 0,
            observationAvailable: reviewable,
            confidence,
            classification: reviewable ? (m.tracks.length > 0 ? 'confirmed' : 'false_alarm') : 'inconclusive',
            modalities: [...new Set(m.tracks.map((track) => track.modality))],
            frames: m.frames,
            geometry: {
              fenceGaps: m.geometry.fence_gaps.map((gap) => ({ lat: gap.lat, lon: gap.lon, widthM: gap.width_m })),
              newStructures: m.geometry.new_structures.map((structure) => ({
                lat: structure.lat, lon: structure.lon,
                footprintM2: structure.footprint_m2, heightM: structure.height_m,
              })),
            },
          };
          void reportService({ vehicleId: m.vehicleId, anomaly, plan: effectivePlan(proposal), observation: summary })
            .then((report) => {
              missionStore.ingestReport(report, m.vehicleId);
              appendFrame({ type: 'incidentReport', ts: Date.now(), vehicleId: m.vehicleId, report });
              pushToast({
                severity: report.verdict === 'escalate' ? 'critical' : 'info',
                title: `Incident report: ${report.verdict.replace('_', ' ')}`,
                message: report.missionId,
              });
            })
            .catch((error: unknown) => {
              reportingRef.current.delete(requestId);
              missionStore.addAudit('report', `Report service failed: ${(error as Error).message}`, m.vehicleId);
            });
        }
      }
    }));
    on(ds.onCapabilities(m => { setCapabilities(m); appendFrame(m); }));
    on(ds.onReadiness(m => { setReadiness(m); appendFrame(m); }));
    on(ds.onHealthEvent(m => {
      setHealth(current => ({ ...current, [m.component]: m }));
      appendFrame(m);
      missionStore.addAudit('health', `${m.component}: ${m.state} — ${m.detail}`, m.vehicleId);
      // A rail's health changed; re-read the bus's own per-rail view for the
      // cue badges (a HealthComponent is coarser than a rail — FM-180).
      if (ds.railHealth) setRailHealth(ds.railHealth());
    }));
    on(ds.onRfEvent(m => {
      // Bounded by AGE as well as count: an RF report describes a moment, and
      // one that has aged out of the window is history, not airspace (FM-51).
      setRfEvents(current => [...current, m]
        .filter(e => m.ts - e.ts <= RF_EVENT_WINDOW_MS)
        .slice(-20));
      appendFrame(m);
      missionStore.addAudit('rf', `${m.source}/${m.kind} ${m.band} (${(m.confidence * 100).toFixed(0)}%)`, m.vehicleId);
    }));
    on(ds.onSpectrum(m => { setSpectrum(m); appendFrame(m); }));
    on(ds.onFleet(m => {
      appendFrame(m);
      missionStore.ingestFleet(m);
      // Per-vehicle tracks: one sample per fleet frame, so a peer that only
      // exists in the fleet stream still draws a track on the map.
      setTrailsByVehicle(current => {
        const next = { ...current };
        for (const v of m.vehicles) {
          if (v.position.relAlt <= 0.5) continue;
          const points = next[v.vehicleId] ?? [];
          const last = points[points.length - 1];
          if (last && Math.abs(last.lat - v.position.lat) < 1e-6 && Math.abs(last.lon - v.position.lon) < 1e-6) continue;
          next[v.vehicleId] = [...points.slice(-120), { lat: v.position.lat, lon: v.position.lon }];
        }
        return next;
      });
    }));

    /* Phase 3 rails: tasking, envelope monitor, attendance, escalations. */
    on(ds.onTask(m => { missionStore.ingestTask(m.task, m.vehicleId); appendFrame(m); }));
    on(ds.onEnvelope(m => { missionStore.ingestEnvelope(m); appendFrame(m); }));
    on(ds.onMode(m => { missionStore.ingestMode(m); appendFrame(m); }));
    on(ds.onEscalation(m => {
      missionStore.ingestEscalation(m);
      appendFrame(m);
      pushToast({
        severity: 'critical',
        title: m.deliveredAt ? 'Escalation raised' : 'Escalation UNDELIVERED',
        message: `${m.missionId} · ${m.channel}`,
      });
    }));

    return () => {
      cancelled = true;
      for (const off of subscriptions) off();
      ds.disconnect();
    };
    // Reconnect when the user changes connection in Settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds, config.host, config.controlPort, config.videoUrl, config.sitl, appendFrame, pushToast]);

  /* Electron SDR sidecar events bypass the WebSocket provider but use the
     same contract envelopes. Passive RF detections are forwarded unchanged
     when a live companion connection is available. */
  useEffect(() => {
    const bridge = window.eis;
    if (!bridge?.onSdrEvent) return;
    const off = bridge.onSdrEvent((event) => {
      appendFrame(event);
      if (event.type === 'spectrum') setSpectrum(event);
      else if (event.type === 'healthEvent') {
        setHealth(current => ({ ...current, [event.component]: event }));
        missionStore.addAudit('health', `${event.component}: ${event.state} — ${event.detail}`, event.vehicleId);
      } else {
        setRfEvents(current => [...current, event]
          .filter(e => event.ts - e.ts <= RF_EVENT_WINDOW_MS)
          .slice(-20));
        missionStore.addAudit('rf', `${event.source}/${event.kind} ${event.band} (${(event.confidence * 100).toFixed(0)}%)`, event.vehicleId);
        ds.forwardRfEvent?.(event);
      }
    });
    void bridge.sdrStart?.({ mode: activeConfig.sitl ? 'scripted' : 'live', vehicleId: DEFAULT_VEHICLE_ID });
    return () => { off(); void bridge.sdrStop?.(); };
  }, [appendFrame, activeConfig.sitl, ds]);

  /* Fleet: follow another vehicle (telemetry, video and commands switch
     together). Works for the ARGUS Hub and for the offline two-vehicle mock —
     both expose the same FleetCapable surface. */
  const selectVehicle = useCallback((id: string) => {
    if (fleetCapable(ds)) ds.setVehicle(id);
    setVehicleId(id);
    missionStore.setVehicle(id);
    resetSamples();
  }, [ds, resetSamples]);

  /* ----- mission flow: approve / deny / abort / report disposition -------- */
  /**
   * Approve = send `executePlan` and WAIT for the vehicle's ack (FM-42).
   *
   * The companion refuses `executePlan` for six documented reasons. Firing and
   * forgetting made every one of them invisible: the operator read "Mission
   * approved", the audit trail recorded it as dispatched, the approve button
   * latched off, and the map drew a mission that never launched. Nothing is
   * recorded as flown until the vehicle says it accepted; a refusal is a
   * failure toast, an audit row naming the reason, and an approve gate that
   * re-opens so the operator can fix the cause and try again.
   */
  const doApprovePlan = (proposal: PlanProposal) => {
    if (readiness?.ready !== true) {
      pushToast({ severity: 'error', title: 'Mission approval blocked', message: readiness?.reasons.join('; ') || 'Readiness is unavailable' });
      return;
    }
    const plan = effectivePlan(proposal);
    const requestId = proposal.plan.requestId;
    flows.setManualActive(false); // exactly one controlSource — planner takes over
    missionStore.noteApprovalSent(requestId, vehicleId);
    pushToast({ severity: 'info', title: 'Mission sent', message: `Awaiting the vehicle's ack for ${plan.requestId}` });
    void ds.sendCommand({ type: 'command', vehicleId, command: 'executePlan', params: { plan } })
      .then((ack: CommandAck) => {
        if (ack.success) {
          missionStore.noteApproval(requestId, vehicleId);
          pushToast({ severity: 'success', title: 'Mission accepted', message: plan.requestId });
          return;
        }
        missionStore.noteExecuteRefused(requestId, ack.message, vehicleId);
        pushToast({
          severity: 'error', title: 'Mission REFUSED by the vehicle',
          message: ack.message || 'no reason given — nothing was dispatched',
        });
      })
      .catch((error: unknown) => {
        // No ack at all is not an acceptance: the same refusal path applies.
        missionStore.noteExecuteRefused(requestId, (error as Error).message, vehicleId);
        pushToast({
          severity: 'error', title: 'Mission dispatch failed',
          message: (error as Error).message,
        });
      });
  };
  const doDenyPlan = (proposal: PlanProposal) => {
    missionStore.noteDenial(proposal.plan.requestId);
    // Denial frees the inspection gate: the operator asked for a plan, read it,
    // and said no. Latching them out of asking for another was FM-81.
    setInspectionLatch(false);
    pushToast({ severity: 'info', title: 'Plan denied', message: proposal.plan.requestId });
  };
  const doAbortPlan = () => {
    cmd('abortPlan');
    missionStore.noteAbort();
    pushToast({ severity: 'warning', title: 'Plan aborted', message: 'Vehicle holding position' });
  };
  const doResolveReport = (r: ReportResolution) => {
    missionStore.resolveReport(r);
    pushToast({
      severity: r === 'escalated' ? 'critical' : 'info',
      title: r === 'escalated' ? 'Escalated to on-site security' : r === 'logged' ? 'Report logged for review' : 'Report dismissed',
    });
  };

  /* ----- Phase 3 rails: gimbal, attendance, tasking, re-plan -------------- */

  /** Gimbal pitch. In Hub mode this maps onto the Hub's `look_at`; providers
   *  without a commandable gimbal ack the refusal and the readout stays as it
   *  was reported (never a fictional value). */
  const onSetGimbal = useCallback((deg: number) => {
    setGimbalPitch(deg);
    cmd('setGimbal', { pitchDeg: deg });
  }, [cmd]);

  /** Unattended entry — a signed operator command, never a toggle. */
  const doEnterUnattended = (id: string) => {
    setOperatorId(id);
    cmd('enterUnattended', { operatorId: id });
    missionStore.addAudit('mode', `Operator ${id} requested UNATTENDED mode (signed confirmation)`, vehicleId);
    pushToast({
      severity: 'warning',
      title: 'Unattended mode requested',
      message: 'The vehicle accepts or refuses; the badge follows what it reports.',
    });
  };
  const doExitUnattended = () => {
    const id = operatorId || 'operator';
    cmd('exitUnattended', { operatorId: id });
    pushToast({ severity: 'info', title: 'Attended operation restored' });
  };

  /** Re-run triage with the operator's note. The note never becomes geometry. */
  const doRunTriage = () => {
    if (!ds.runTriage) return;
    const note = missionStore.get().operatorNote;
    missionStore.noteTriageRun(note, vehicleId);
    ds.runTriage(note);
  };

  /** The operator dropped the cue somewhere else: the SOURCE re-plans through
   *  the deterministic planner and the verifier. The UI never edits a plan. */
  const doMoveAnomaly = useCallback((anomalyId: string, lat: number, lon: number) => {
    ds.moveAnomaly?.(anomalyId, lat, lon);
  }, [ds]);

  const doScenario = (name: DemoScenario) => {
    ds.runScenario?.(name);
  };

  /* ----- manual (game-controller) stick stream ---------------------------- */
  const onStickInput = useCallback((v: ManualInput) => ds.setManualInput(v), [ds]);

  /* ----- derived flight state --------------------------------------------- */
  const trackingActive = !!tracking && tracking.state !== 'idle';
  const flying = (tel?.position?.relAlt ?? 0) > AIRBORNE_MIN_ALT_M;
  const hostLabel = activeConfig.sitl ? 'sitl' : activeConfig.host;
  const plannerActive = tel?.controlSource === 'planner';

  /* ----- keyboard shortcuts ----------------------------------------------- */
  useKeyboardShortcuts({
    space: { preventDefault: true, run: flows.disarm },
    t: { when: () => tracking?.state === 'idle' && flying, run: flows.engageTracking },
    d: { when: () => trackingActive, run: () => cmd('disengageTracking') },
    r: { when: () => flying, run: () => cmd('rtl') },
  });

  useDisplayWakeLock(!!tel?.armed || flows.manualActive || trackingActive || plannerActive);

  const sensorState = (state?: string): SensorHealth | undefined => {
    if (state === 'ok' || state === 'ready' || state === 'nominal') return 'ok';
    if (state === 'degraded') return 'degraded';
    if (state === 'failed' || state === 'unavailable' || state === 'fault') return 'failed';
    return undefined;
  };
  const sensorHealth: Partial<Record<'rgb' | 'thermal' | 'lidar', SensorHealth>> = {
    rgb: sensorState(health.camera?.state) ?? observation?.sensors.rgb,
    thermal: sensorState(health.thermal?.state) ?? observation?.sensors.thermal,
    lidar: sensorState(health.lidar?.state) ?? observation?.sensors.lidar,
  };

  const updateSimulation = (next: Partial<SimulationToggles>) => {
    setSimulationToggles(current => ({ ...current, ...next }));
    ds.setSimulationToggles?.(next);
  };

  const startLiveInspection = async (): Promise<void> => {
    const planner = window.eis?.plannerPropose;
    if (ds.kind !== 'live' || livePlanning || liveStartedRef.current) return;
    if (!planner) {
      pushToast({ severity: 'error', title: 'Planner service unavailable', message: 'Run the ground station inside an Electron shell.' });
      return;
    }
    if (!mission.site || !tel || !capabilities || !readiness) {
      pushToast({
        severity: 'warning', title: 'Waiting for live context',
        message: 'Site, telemetry, capabilities, and readiness must arrive before planning.',
      });
      return;
    }
    setLivePlanning(true);
    const anomaly = liveDemoAnomaly(mission.site);
    missionStore.ingestAnomaly(anomaly, tel.vehicleId);
    appendFrame({ type: 'anomaly', ts: Date.now(), vehicleId: tel.vehicleId, anomaly });
    setCenterView('mission');
    const allSensors = sensorHealth.rgb && sensorHealth.thermal && sensorHealth.lidar
      ? { rgb: sensorHealth.rgb, thermal: sensorHealth.thermal, lidar: sensorHealth.lidar }
      : undefined;
    const context: VerificationContext = {
      telemetry: { battery: tel.battery, navSource: tel.navSource, position: tel.position },
      battery: tel.battery,
      navSource: tel.navSource,
      currentPosition: tel.position,
      currentAltitudeM: tel.position.relAlt,
      readiness: { ready: readiness.ready, reasons: readiness.reasons },
      // Measured when the vehicle has reported one, otherwise the documented
      // stand-in, tagged so the verifier can tell them apart (FM-72).
      ...windContext(health.wind),
      anomaly,
      rfEvents,
      now: Date.now(),
      ...(spectrum ? { sdrState: spectrum.state } : {}),
      ...(allSensors ? { sensors: allSensors } : {}),
      isNight: import.meta.env.VITE_EIS_DEMO_NIGHT === 'true',
      maxSortieS: capabilities.max_sortie_s,
      dispatchMinSocPct: capabilities.dispatch_min_soc_pct,
      profileCapabilities: capabilities.profiles,
    };
    try {
      const result = await planner({
        vehicleId: tel.vehicleId,
        anomaly,
        telemetry: tel,
        capabilities,
        context,
      });
      // The deterministic planner can refuse a task outright, in which case
      // there is no plan and no verdict to ingest — only a reason.
      if (!result.plan || !result.verification) {
        missionStore.addAudit('plan',
          `Ground planner refused the task: ${result.infeasibleReason ?? result.escalationReason ?? 'no reason given'}`,
          result.vehicleId);
        pushToast({
          severity: 'error', title: 'Planner refused the task',
          message: result.infeasibleReason ?? result.escalationReason ?? 'no plan was produced',
        });
        return;
      }
      missionStore.ingestPlan(result.plan, result.vehicleId);
      missionStore.ingestVerification(result.verification, result.vehicleId);
      missionStore.addAudit('plan', `Ground planner ${result.source}, ${result.attempts} attempt(s)${result.fallbackReason ? `; fallback: ${result.fallbackReason}` : ''}`, result.vehicleId);
      appendFrame({ type: 'missionPlan', ts: Date.now(), vehicleId: result.vehicleId, plan: result.plan });
      appendFrame({ type: 'verification', ts: Date.now(), vehicleId: result.vehicleId, verification: result.verification });
      // Only a plan the operator can act on closes the inspection gate. A
      // rejected verdict, a refused task and a thrown planner all leave it
      // open, because in every one of those cases the next thing the operator
      // needs is another attempt (FM-81).
      setInspectionLatch(result.verification.verdict !== 'rejected');
      pushToast({
        severity: result.verification.verdict === 'rejected' ? 'error' : 'success',
        title: `Planner result: ${result.verification.verdict}`,
        message: result.escalationReason ?? result.plan.requestId,
      });
    } catch (error) {
      pushToast({ severity: 'error', title: 'Planning failed', message: (error as Error).message });
    } finally {
      setLivePlanning(false);
    }
  };

  /* Home + the plan route to draw: the approved (executing) plan wins,
     otherwise the proposal selected in the verifier panel. */
  const home = mission.site
    ? { lat: mission.site.home.lat, lon: mission.site.home.lon }
    : FALLBACK_HOME;
  const selectedProposal =
    mission.proposals.find(p => p.plan.requestId === mission.selectedRequestId) ??
    mission.proposals[mission.proposals.length - 1] ?? null;
  const executedProposal = mission.executedRequestId
    ? mission.proposals.find(p => p.plan.requestId === mission.executedRequestId) ?? null
    : null;
  const routePlan = executedProposal
    ? effectivePlan(executedProposal)
    : selectedProposal ? effectivePlan(selectedProposal) : null;
  const envelope = envelopeOf(mission);

  return (
    <div
      className="eis-root"
      style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-app)', overflow: 'hidden' }}
    >
      <StatusBar
        tel={tel}
        connState={connState}
        sitl={activeConfig.sitl}
        sourceKind={ds.kind}
        host={hostLabel}
        elapsed={elapsed}
        controllerOn={controllerOn}
        manualActive={flows.manualActive}
        health={health}
        spectrum={spectrum}
        onDisarm={flows.disarm}
        onOpenSettings={() => openModal('settings')}
        onOpenFailsafe={() => openModal('failsafe')}
        onOpenPid={() => openModal('pid')}
        onOpenLogs={() => openModal('logbrowser')}
        fleet={fleet}
        selectedVehicle={vehicleId}
        onSelectVehicle={selectVehicle}
        envelope={envelope}
        attendance={mission.attendance}
        escalationCount={mission.escalations.length}
        undeliveredCount={mission.escalations.filter((e) => !e.deliveredAt).length}
        onOpenOutbox={() => { setCenterView('mission'); setReportTab('outbox'); }}
        onEnterUnattended={() => openModal('unattended')}
        onExitUnattended={doExitUnattended}
      />

      {trackingActive && (
        <TrackingBanner standoff={flows.standoff} maxSpeed={flows.maxSpeed} onDisengage={() => cmd('disengageTracking')} />
      )}
      {flows.manualActive && <ManualBanner onRelease={flows.releaseManual} />}
      {plannerActive && <PlannerBanner requestId={mission.executedRequestId} onAbort={doAbortPlan} />}

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'var(--leftpanel-w) 1fr var(--rightpanel-w)', gap: 10, padding: 10 }}>
        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'auto', paddingRight: 2 }}>
          <ControlsPanel
            tel={tel}
            tracking={tracking}
            connState={connState}
            standoff={flows.standoff}
            maxSpeed={flows.maxSpeed}
            onCmd={cmd}
            onSetStandoff={flows.setStandoff}
            onSetMaxSpeed={flows.setMaxSpeed}
            onArm={flows.arm}
            onTakeoff={flows.requestTakeoff}
            onEngage={flows.engageTracking}
            checklistDone={flows.checklistDone}
            gimbalPitch={gimbalPitch}
            onSetGimbal={onSetGimbal}
          />
          <ManualControl
            armed={!!tel?.armed}
            flying={flying}
            manualActive={flows.manualActive}
            onEngage={flows.engageManual}
            onRelease={flows.releaseManual}
            onInput={onStickInput}
            onControllerChange={setControllerOn}
          />
          {ds.kind === 'mock' && activeConfig.sitl && (
            <SimulationPanel
              value={simulationToggles}
              onChange={updateSimulation}
              onScenario={ds.runScenario ? doScenario : undefined}
              hint={ds.scenarioHint?.bind(ds)}
            />
          )}
        </div>

        {/* CENTER */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          {/* view switcher: classic flight ops vs the mission workspace */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
            <Tabs
              size="sm"
              value={centerView}
              onChange={(id) => setCenterView(id as CenterView)}
              items={[
                { id: 'flight', label: 'Flight ops' },
                { id: 'mission', label: 'Mission' },
                ...(isHubMode() ? [{ id: 'world', label: 'ARGUS World view' }] : []),
              ]}
            />
            {centerView === 'flight' && mission.anomalies.length > 0 && (
              <Badge tone="caution" mono>
                {mission.anomalies.length} ANOMAL{mission.anomalies.length === 1 ? 'Y' : 'IES'}
              </Badge>
            )}
            {mission.executing && <Badge tone="accent" mono>MISSION EXECUTING</Badge>}
            {ds.kind === 'live' && (
              <Button
                variant="primary"
                disabled={livePlanning || inspectionPlanned || connState !== 'connected'}
                onClick={() => void startLiveInspection()}
                style={{ marginLeft: 'auto' }}
              >
                {livePlanning ? 'Planning inspection…' : inspectionPlanned ? 'Inspection planned' : 'Start scripted inspection'}
              </Button>
            )}
          </div>

          {centerView === 'world' ? (
            <div style={{ flex: 1, minHeight: 0, borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--border-default)', background: '#000' }}>
              <iframe
                title="ARGUS World view"
                src={consoleUrl(config)}
                style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
                allow="fullscreen"
              />
            </div>
          ) : centerView === 'flight' ? (
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: '1.55fr 1fr', gap: 10 }}>
              <div style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--border-default)', minHeight: 0 }}>
                <VideoPanel
                  tracking={tracking}
                  connState={connState}
                  standoff={flows.standoff}
                  onSelectTarget={(id: number) => cmd('selectTarget', { targetId: id })}
                  videoUrl={ds.getVideoUrl()}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 10, minHeight: 0 }}>
                <MapPanel
                  tel={tel}
                  tracking={tracking}
                  home={home}
                  trail={trail}
                  geofenceRadius={settings.failsafe.geofenceRadius}
                />
                <LogConsole
                  logs={logs}
                  recording={recording}
                  onToggleRecord={toggleRecording}
                  onOpenBrowser={() => openModal('logbrowser')}
                />
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'auto 1.2fr 1fr', gap: 8 }}>
              <MissionStatusStrip
                telemetry={tel}
                readiness={readiness}
                health={health}
                sensors={sensorHealth}
                spectrum={spectrum}
                rfEvents={rfEvents}
                onContinue={() => cmd('continueMission')}
                onRtl={() => cmd('rtl')}
              />
              <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr 0.85fr', gap: 10, minHeight: 0 }}>
                <MissionMap
                  site={mission.site}
                  tel={tel}
                  trail={trail}
                  anomalies={mission.anomalies}
                  plan={routePlan}
                  executing={mission.executing}
                  observation={observation}
                  rfEvents={rfEvents}
                  fleet={mission.fleet}
                  envelopeByVehicle={mission.envelopeByVehicle}
                  trailsByVehicle={trailsByVehicle}
                  selectedVehicle={vehicleId}
                  onSelectVehicle={selectVehicle}
                  onMoveAnomaly={ds.moveAnomaly ? doMoveAnomaly : undefined}
                />
                <TaskPlanPanel
                  tasks={mission.tasks}
                  operatorNote={mission.operatorNote}
                  onOperatorNote={(note) => missionStore.setOperatorNote(note)}
                  onRunTriage={doRunTriage}
                  onReorder={(taskId, delta) => missionStore.reorderTask(taskId, delta)}
                  triageAvailable={!!ds.runTriage}
                  plan={routePlan}
                  verification={selectedProposal?.verification ?? null}
                  dragToReplan={!!ds.moveAnomaly}
                />
                {/* Observation and cue provenance share one slot: new rails are
                    tabs, badges and pin colours — never another panel. */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
                  <Tabs
                    size="sm"
                    value={sideView}
                    onChange={(id) => setSideView(id as SideView)}
                    items={[
                      { id: 'observation', label: 'Observation' },
                      { id: 'cues', label: `Cues${mission.anomalies.length ? ` (${mission.anomalies.length})` : ''}` },
                    ]}
                    style={{ flex: 'none', alignSelf: 'flex-start' }}
                  />
                  <div style={{ flex: 1, minHeight: 0 }}>
                    {sideView === 'observation'
                      ? <ObservationPanel observation={observation} sensorHealth={sensorHealth} />
                      : <SatellitePanel anomalies={mission.anomalies} railHealth={railHealth} />}
                  </div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr 0.9fr', gap: 10, minHeight: 0 }}>
                <VerifierPanel
                  proposals={mission.proposals}
                  selectedRequestId={mission.selectedRequestId}
                  executing={mission.executing}
                  onSelect={(id) => missionStore.select(id)}
                  onApprove={doApprovePlan}
                  onDeny={doDenyPlan}
                  readinessReady={readiness?.ready === true}
                  readinessReasons={readiness?.reasons ?? ['readiness unavailable']}
                />
                <ReportPanel
                  report={mission.report}
                  resolution={mission.reportResolution}
                  onResolve={doResolveReport}
                  records={mission.records}
                  escalations={mission.escalations}
                  tab={reportTab}
                  onTabChange={setReportTab}
                />
                <AuditLogPanel events={mission.audit} />
              </div>
            </div>
          )}
        </div>

        {/* RIGHT */}
        <TelemetryPanel tel={tel} tracking={tracking} history={history} />
      </div>

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <ModalHost
        modal={modal}
        onClose={closeModal}
        onChecklistComplete={flows.completeChecklist}
        onConfirmTakeoff={flows.confirmTakeoff}
        onEnterUnattended={doEnterUnattended}
        operatorId={operatorId}
      />
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
