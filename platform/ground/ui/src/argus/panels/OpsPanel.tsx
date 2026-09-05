import React from 'react';
import { Panel, Button } from '@/components';
import { useArgus, activeMission } from '../store';

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
}

const SCENARIOS: { kind: string; label: string; hint: string }[] = [
  { kind: 'intruder_vehicle', label: 'Intruder vehicle', hint: 'A vehicle stops against the outer fence' },
  { kind: 'unattended_object', label: 'Unattended object', hint: 'A crate beside the reactor, inside the protected area' },
  { kind: 'unattended_object_benign', label: 'Benign object', hint: 'The same crate in the service yard' },
  { kind: 'authorized_activity', label: 'Authorized activity', hint: 'Marked maintenance vehicle during a declared window' },
  { kind: 'perimeter_opening', label: 'Perimeter opening', hint: 'A fence section is opened' },
];

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>{children}</div>
);
const Label = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-tertiary)', margin: '6px 0 4px' }}>{children}</div>
);

export function OpsPanel({ act }: { act: OpsActions }): React.ReactElement {
  const selected = useArgus((s) => s.selected);
  const detections = useArgus((s) => s.detections);
  const baselineRef = useArgus((s) => s.baselineRef);
  const dispatching = useArgus((s) => s.dispatching);
  const manualActive = useArgus((s) => s.manualActive);
  const mission = useArgus((s) => activeMission(s, selected));
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const [busy, setBusy] = React.useState<string | null>(null);
  const run = (key: string, fn: () => Promise<void>) => async () => { setBusy(key); try { await fn(); } finally { setBusy(null); } };
  const latest = detections[detections.length - 1];
  const dispatchReason = !latest ? 'Run Detect change first' : dispatching ? `Dispatching ${dispatching}…` : `Dispatch ${latest.id} to the Triage Agent`;
  const airborne = (drone?.alt ?? 0) > 0.5;
  const sz = 'sm' as const;

  return (
    <Panel title="Operations" pad scroll style={{ flex: '1 1 0', minHeight: 0 }}>
      <Label>Wide-area</Label>
      <Row>
        <Button size={sz} onClick={run('baseline', act.baseline)} pending={busy === 'baseline'} title="Capture the overhead baseline (before image)">Baseline</Button>
        <Button size={sz} onClick={run('detect', act.detect)} pending={busy === 'detect'} disabled={!baselineRef} title={baselineRef ? 'Capture the after image and run change detection' : 'Capture a Baseline first'}>Detect change</Button>
      </Row>
      <div style={{ marginTop: 6 }}>
        <Button size={sz} variant="primary" block onClick={run('dispatch', act.dispatch)} pending={busy === 'dispatch' || !!dispatching} disabled={!latest || !!dispatching} title={dispatchReason}>
          {dispatching ? 'Dispatching…' : latest ? `Dispatch ${latest.id}` : 'Dispatch'}
        </Button>
        {!latest && <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 3 }}>{dispatchReason}</div>}
      </div>

      <Label>Selected Drone {selected ? `· ${selected}` : ''}</Label>
      <Row>
        <Button size={sz} onClick={run('rth', act.returnHome)} pending={busy === 'rth'} disabled={!selected} title="Return the selected Drone to its pad (R)">Return home</Button>
        <Button size={sz} onClick={run('square', act.flySquare)} pending={busy === 'square'} disabled={!selected || !!mission} title="Dev: fly the square fixture">Fly square</Button>
      </Row>
      <Row>
        {mission?.phase === 'paused'
          ? <Button size={sz} onClick={run('resume', act.resume)} pending={busy === 'resume'} title={`Resume ${mission.mission_id}`}>Resume</Button>
          : <Button size={sz} onClick={run('pause', act.pause)} pending={busy === 'pause'} disabled={mission?.phase !== 'flying'} title={mission ? `Pause ${mission.mission_id}` : 'No active Mission'}>Pause</Button>}
        <Button size={sz} variant="danger" onClick={run('abort', act.abort)} pending={busy === 'abort'} disabled={!mission} title={mission ? `Abort ${mission.mission_id} and return home` : 'No active Mission'}>Abort</Button>
      </Row>
      {mission && (
        <div className="eis-readout" style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 4 }}>
          Mission {mission.mission_id} · {mission.phase} · wp {mission.next_waypoint}{mission.error ? ` · ${mission.error}` : ''}
        </div>
      )}

      <Label>Manual Control</Label>
      {manualActive
        ? <Button size={sz} variant="danger" block onClick={run('release', act.manualRelease)} pending={busy === 'release'} title="Hand control back (H): the paused Mission resumes">Release (H)</Button>
        : <Button size={sz} variant="secondary" block onClick={run('take', act.manualTake)} pending={busy === 'take'} disabled={!selected} title={airborne ? 'Take Manual Control of the selected Drone' : 'Take Manual Control (the Drone will take off to 3 m)'}>Take control</Button>}
      <div className="argus-hint" style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 4, lineHeight: 1.45 }}>
        W/S forward · A/D strafe · Q/E down/up · ◄ ► yaw. The Safety Validator clamps at the geofence and ceiling.
      </div>

      <Label>Scenario</Label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 4 }}>
        {SCENARIOS.map((sc) => (
          <Button key={sc.kind} size={sz} variant="ghost" block onClick={run(sc.kind, () => act.scenario(sc.kind))} pending={busy === sc.kind} title={sc.hint} style={{ justifyContent: 'flex-start', minWidth: 0 }}>{sc.label}</Button>
        ))}
        <Button size={sz} variant="ghost" block onClick={run('reset', act.resetScene)} pending={busy === 'reset'} title="Restore the Site baseline" style={{ justifyContent: 'flex-start' }}>Reset Site</Button>
      </div>
    </Panel>
  );
}
