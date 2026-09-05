import React from 'react';
import { SlidersHorizontal, Camera, ScanSearch, Send, Home, Route, Pause, Play, Square, Hand, HandMetal, Car, Package, PackageCheck, Wrench, DoorOpen, RotateCcw, Minus, Plus, Video, ZoomIn, ZoomOut } from 'lucide-react';
import { Panel, Button } from '@/components';
import { useArgus, activeMission, CAMERA_MODES, FOV_MAX, FOV_MIN, fovToZoom, zoomToFov, type CameraMode } from '../store';

export interface OpsActions {
  baseline(): Promise<void>;
  detect(): Promise<void>;
  dispatch(): Promise<void>;
  returnHome(): Promise<void>;
  flySquare(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  abort(): Promise<void>;
  scenario(kind: string): Promise<void>;
  resetScene(): Promise<void>;
  manualTake(): Promise<void>;
  manualRelease(): Promise<void>;
  /** Point the camera: -30 (up) .. 90 (straight down). Debounced by the caller. */
  gimbal(pitchDeg: number): void;
  /** Sensor the Renderer draws for this Drone's feed. */
  cameraMode(mode: CameraMode): void;
  /** Field of view in degrees (110 wide .. 20 narrow); debounced by the caller. */
  cameraFov(fovDeg: number): void;
}

export const GIMBAL_MIN = -30;
export const GIMBAL_MAX = 90;

const SCENARIOS: { kind: string; label: string; hint: string; icon: React.ReactNode }[] = [
  { kind: 'intruder_vehicle', label: 'Intruder vehicle', hint: 'A vehicle stops against the outer fence', icon: <Car size={13} /> },
  { kind: 'unattended_object', label: 'Unattended object', hint: 'A crate beside the reactor, inside the protected area', icon: <Package size={13} /> },
  { kind: 'unattended_object_benign', label: 'Benign object', hint: 'The same crate in the service yard', icon: <PackageCheck size={13} /> },
  { kind: 'authorized_activity', label: 'Authorized activity', hint: 'Marked maintenance vehicle during a declared window', icon: <Wrench size={13} /> },
  { kind: 'perimeter_opening', label: 'Perimeter opening', hint: 'A fence section is opened', icon: <DoorOpen size={13} /> },
];

const Section = ({ children }: { children: React.ReactNode }) => (
  <div className="a-section"><span className="a-label">{children}</span></div>
);

export function OpsPanel({ act }: { act: OpsActions }): React.ReactElement {
  const selected = useArgus((s) => s.selected);
  const detections = useArgus((s) => s.detections);
  const baselineRef = useArgus((s) => s.baselineRef);
  const dispatching = useArgus((s) => s.dispatching);
  const manualActive = useArgus((s) => s.manualActive);
  const mission = useArgus((s) => activeMission(s, selected));
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const gimbalPending = useArgus((s) => s.gimbalPending);
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = (key: string, fn: () => Promise<void>) => async () => { setBusy(key); try { await fn(); } finally { setBusy(null); } };
  const latest = detections[detections.length - 1];
  const dispatchReason = !latest ? 'Detect change first' : dispatching ? `Dispatching ${dispatching}` : `Dispatch ${latest.id} to the Triage Agent`;
  const airborne = (drone?.alt ?? 0) > 0.5;
  const gimbal = gimbalPending ?? drone?.gimbal_pitch_deg ?? 45;
  const cam = useArgus((s) => (s.selected ? s.camera[s.selected] : undefined)) ?? { mode: 'rgb' as CameraMode, fov_deg: 70 };
  const zoom = fovToZoom(cam.fov_deg);
  const sz = 'sm' as const;

  return (
    <Panel title="Operations" icon={<SlidersHorizontal size={13} />} pad scroll style={{ flex: '1 1 0', minHeight: 0 }}>
      <Section>Overhead</Section>
      <div className="a-row2">
        <Button size={sz} icon={<Camera size={13} />} onClick={run('baseline', act.baseline)} pending={busy === 'baseline'} title="Capture the overhead baseline">Baseline</Button>
        <Button size={sz} icon={<ScanSearch size={13} />} onClick={run('detect', act.detect)} pending={busy === 'detect'} disabled={!baselineRef} title={baselineRef ? 'Capture again and compare with the baseline' : 'Capture a Baseline first'}>Detect</Button>
      </div>
      <div style={{ marginTop: 6 }}>
        <Button size={sz} variant="primary" block icon={<Send size={13} />} onClick={run('dispatch', act.dispatch)} pending={busy === 'dispatch' || !!dispatching} disabled={!latest || !!dispatching} title={dispatchReason}>
          {dispatching ? 'Dispatching' : latest ? `Dispatch ${latest.id}` : 'Dispatch'}
        </Button>
        {!latest && <div className="a-body" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{dispatchReason}.</div>}
      </div>

      <Section>{selected ?? 'Drone'}</Section>
      <div className="a-row2">
        <Button size={sz} icon={<Home size={13} />} onClick={run('rth', act.returnHome)} pending={busy === 'rth'} disabled={!selected} title="Return to pad (R)">Return</Button>
        <Button size={sz} icon={<Route size={13} />} onClick={run('square', act.flySquare)} pending={busy === 'square'} disabled={!selected || !!mission} title="Fly the test square">Test flight</Button>
      </div>
      <div className="a-row2" style={{ marginTop: 6 }}>
        {mission?.phase === 'paused'
          ? <Button size={sz} icon={<Play size={13} />} onClick={run('resume', act.resume)} pending={busy === 'resume'} title={`Resume ${mission.mission_id}`}>Resume</Button>
          : <Button size={sz} icon={<Pause size={13} />} onClick={run('pause', act.pause)} pending={busy === 'pause'} disabled={mission?.phase !== 'flying'} title={mission ? `Pause ${mission.mission_id}` : 'No active Mission'}>Pause</Button>}
        <Button size={sz} variant="danger-soft" icon={<Square size={12} />} onClick={run('abort', act.abort)} pending={busy === 'abort'} disabled={!mission} title={mission ? `Abort ${mission.mission_id} and return home` : 'No active Mission'}>Abort</Button>
      </div>
      {mission && (
        <div className="a-num" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5, lineHeight: 1.4 }}>
          {mission.mission_id} · {mission.phase} · wp {mission.next_waypoint}{mission.error ? ` · ${mission.error}` : ''}
        </div>
      )}

      <Section>Camera</Section>
      <div className="a-gimbal" title="Gimbal pitch: [ and ] step 5°. 0° level, 90° straight down, negative looks up">
        <button className="a-icobtn" onClick={() => act.gimbal(Math.max(GIMBAL_MIN, gimbal - 5))} disabled={!selected} aria-label="Tilt camera up"><Minus size={13} /></button>
        <input type="range" min={GIMBAL_MIN} max={GIMBAL_MAX} step={1} value={gimbal} disabled={!selected} onChange={(e) => act.gimbal(Number(e.target.value))} aria-label="Gimbal pitch" />
        <button className="a-icobtn" onClick={() => act.gimbal(Math.min(GIMBAL_MAX, gimbal + 5))} disabled={!selected} aria-label="Tilt camera down"><Plus size={13} /></button>
        <span className="a-num" style={{ fontSize: 12, textAlign: 'right' }}>{gimbal}<span className="a-unit">°</span></span>
      </div>
      <div className="a-body argus-hint" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3, display: 'flex', alignItems: 'center', gap: 5 }}>
        <Video size={11} /> {gimbal < 0 ? 'Looking up' : gimbal === 0 ? 'Level' : gimbal >= 85 ? 'Straight down' : 'Tilted down'} · keys [ ]
      </div>
      <div className="a-seg" role="group" aria-label="Sensor" style={{ marginTop: 8 }} title="Sensor the feed shows (V cycles)">
        {CAMERA_MODES.map((m) => (
          <button key={m} data-on={cam.mode === m || undefined} disabled={!selected} onClick={() => act.cameraMode(m)}>{m === 'rgb' ? 'RGB' : m === 'thermal' ? 'Thermal' : 'LiDAR'}</button>
        ))}
      </div>
      <div className="a-gimbal" style={{ marginTop: 6 }} title="Zoom: field of view 110° (1x) to 20° (5.5x). Keys - and =">
        <button className="a-icobtn" onClick={() => act.cameraFov(zoomToFov(zoom - 0.5))} disabled={!selected || cam.fov_deg >= FOV_MAX} aria-label="Zoom out"><ZoomOut size={13} /></button>
        <input type="range" min={10} max={55} step={1} value={Math.round(zoom * 10)} disabled={!selected} onChange={(e) => act.cameraFov(zoomToFov(Number(e.target.value) / 10))} aria-label="Zoom" />
        <button className="a-icobtn" onClick={() => act.cameraFov(zoomToFov(zoom + 0.5))} disabled={!selected || cam.fov_deg <= FOV_MIN} aria-label="Zoom in"><ZoomIn size={13} /></button>
        <span className="a-num" style={{ fontSize: 12, textAlign: 'right' }}>{zoom.toFixed(1)}<span className="a-unit">x</span></span>
      </div>
      <div className="a-body argus-hint" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3 }}>Field of view {Math.round(cam.fov_deg)}° · keys - =</div>

      <Section>Manual control</Section>
      {manualActive
        ? <Button size={sz} variant="danger-soft" block icon={<HandMetal size={13} />} onClick={run('release', act.manualRelease)} pending={busy === 'release'} title="Hand control back (H): the paused Mission resumes">Release control · H</Button>
        : <Button size={sz} variant="secondary" block icon={<Hand size={13} />} onClick={run('take', act.manualTake)} pending={busy === 'take'} disabled={!selected} title={airborne ? 'Fly the selected Drone yourself' : 'Take control (the Drone lifts to 3 m)'}>Take control</Button>}
      <div className="a-body argus-hint" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
        W S forward · A D strafe · Q E down up · ◄ ► yaw. The Safety Validator stops you at the fence and ceiling.
      </div>

      <Section>Scenario</Section>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 3 }}>
        {SCENARIOS.map((sc) => (
          <Button key={sc.kind} size={sz} variant="ghost" block icon={sc.icon} onClick={run(sc.kind, () => act.scenario(sc.kind))} pending={busy === sc.kind} title={sc.hint} style={{ justifyContent: 'flex-start', minWidth: 0, paddingLeft: 8 }}>{sc.label}</Button>
        ))}
        <Button size={sz} variant="ghost" block icon={<RotateCcw size={13} />} onClick={run('reset', act.resetScene)} pending={busy === 'reset'} title="Restore the Site baseline" style={{ justifyContent: 'flex-start', paddingLeft: 8 }}>Reset Site</Button>
      </div>
    </Panel>
  );
}
