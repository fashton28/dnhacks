import React from 'react';
import { ShieldCheck, FileText } from 'lucide-react';
import { useArgus, activeMission, CAMERA_MODES, fovToZoom, type CameraMode } from '../store';
import { DroneCard } from './FleetPanel';
import { ArgusMark } from '../Brand';

/** Fleet cards, the selected Drone's Mission, the Safety Validator's verdict and the camera, as glass along the bottom. */
export function BottomStrip({ onSelect, onCameraMode }: { onSelect: (id: string) => void; onCameraMode: (m: CameraMode) => void }): React.ReactElement {
  const fleet = useArgus((s) => s.fleet);
  const selected = useArgus((s) => s.selected);
  const mission = useArgus((s) => activeMission(s, s.selected));
  const validation = useArgus((s) => s.validation);
  const lastReport = useArgus((s) => { const m = activeMission(s, s.selected); const id = m?.mission_id ?? s.incident?.mission_id ?? null; return id && s.reports[id] ? id : null; });
  const openFindings = useArgus((s) => s.openFindings);
  const clamp = useArgus((s) => s.clamp);
  const cam = useArgus((s) => (s.selected ? s.camera[s.selected] : undefined)) ?? { mode: 'rgb' as CameraMode, fov_deg: 70 };
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const drones = React.useMemo(() => Object.values(fleet).sort((a, b) => a.drone_id.localeCompare(b.drone_id)), [fleet]);
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const live = !!drone && now - new Date(drone.ts).getTime() < 4000;
  const n = mission?.plan?.waypoints.length ?? 0;
  const vTone = !validation ? 'var(--text-tertiary)' : validation.verdict === 'accept' ? 'var(--green-bright)' : 'var(--red-bright)';
  const recentClamp = !!clamp && now - clamp.ts < 5000;
  return (
    <div className="a-strip">
      <div className="a-glass">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="a-label">Fleet</span><span style={{ flex: 1 }} /><span className="a-label" style={{ color: 'var(--text-secondary)', textTransform: 'none', letterSpacing: '0.02em' }}>keys 1 2 3</span></div>
        {drones.length === 0 ? (
          <div className="a-empty" style={{ minHeight: 60, width: 300 }}><ArgusMark size={22} /><div className="a-body"><b>No Drones on the Hub.</b> Start the fleet with <span className="a-num">make sim</span>.</div></div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            {drones.map((s, i) => <DroneCard key={s.drone_id} s={s} index={i} selected={s.drone_id === selected} onSelect={onSelect} />)}
          </div>
        )}
      </div>
      <div className="a-glass" style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
          <span className="a-label">Mission</span>
          {mission && <span className="a-id" style={{ color: 'var(--text-secondary)', fontWeight: 500 }}>{mission.mission_id}</span>}
          <span style={{ flex: 1 }} />
          {lastReport && <button className="a-icobtn" style={{ width: 'auto', padding: '0 8px', gap: 5, height: 22 }} onClick={() => openFindings(lastReport)} title="Open the findings document"><FileText size={12} /><span className="a-label" style={{ color: 'inherit' }}>Findings</span></button>}
          {mission && <span className="a-chip" style={{ color: mission.phase === 'paused' ? 'var(--amber-bright)' : 'var(--green-bright)' }}>{mission.phase}</span>}
        </div>
        {mission ? (
          <>
            {n > 0 && <div className="a-wps">{Array.from({ length: n }, (_, i) => <span key={i} data-done={i < mission.next_waypoint} data-cur={i === mission.next_waypoint && mission.phase === 'flying'} />)}</div>}
            <div className="a-body">Waypoint <span className="a-num">{mission.next_waypoint} / {n}</span>{mission.plan ? <> · {mission.plan.pattern} · est. <span className="a-num">{mission.plan.est_duration_s.toFixed(0)} s</span></> : null} · <span className="a-num">{mission.evidence?.length ?? 0}</span> evidence frames{mission.error ? <span style={{ color: 'var(--red-bright)' }}> · {mission.error}</span> : null}</div>
          </>
        ) : (
          <div className="a-body" style={{ color: 'var(--text-tertiary)' }}>{selected ? `${selected} has no active Mission. Dispatch a Detection, or fly the test square from Ops.` : 'Select a Drone.'}</div>
        )}
      </div>
      <div className="a-glass" style={{ width: 250 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: vTone, whiteSpace: 'nowrap' }}>
          <ShieldCheck size={14} /><span className="a-label">Safety Validator</span><span style={{ flex: 1 }} />
          {validation && <span className="a-chip" style={{ color: vTone }}>{validation.abandoned ? 'abandoned' : validation.verdict === 'accept' ? 'accepted' : 'rejected'}</span>}
        </div>
        {!validation ? (
          <div className="a-body" style={{ color: 'var(--text-tertiary)' }}>Every FlightPlan is checked against the geofence, no-fly zones, ceiling and range before a motor spins.</div>
        ) : validation.verdict === 'accept' ? (
          <div className="a-body">{validation.checks_passed ? <><span className="a-num">{validation.checks_passed}</span> checks: </> : ''}geofence, no-fly, ceiling, range, standoff.</div>
        ) : (
          <div className="a-body"><span className="a-id" style={{ color: 'var(--red-bright)', fontSize: 11 }}>{validation.violations[0]?.rule}</span> <span style={{ color: 'var(--text-secondary)' }}>{validation.violations[0]?.detail}</span></div>
        )}
        <div className="a-body" style={{ color: recentClamp ? 'var(--amber-bright)' : 'var(--text-tertiary)' }}>
          {recentClamp && clamp ? `Clamped: ${clamp.rule.replace(/[+_]/g, ' ')}` : 'Manual control clamps every command against the same rules.'}
        </div>
      </div>
      <div className="a-glass" style={{ width: 196, whiteSpace: 'nowrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="a-label">Camera</span><span style={{ flex: 1 }} /><span className="a-hud" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: live ? 'var(--red-bright)' : 'var(--amber-bright)' }}><span className="a-dot" data-live={live} />{live ? 'LIVE' : 'NO SIGNAL'}</span></div>
        <div className="a-segpills" role="group" aria-label="Sensor">
          {CAMERA_MODES.map((m) => <button key={m} data-on={cam.mode === m} disabled={!selected} onClick={() => onCameraMode(m)}>{m === 'rgb' ? 'RGB' : m === 'thermal' ? 'Thermal' : 'LiDAR'}</button>)}
        </div>
        <div className="a-body">FOV <span className="a-num">{Math.round(cam.fov_deg)}°</span> · zoom <span className="a-num">{fovToZoom(cam.fov_deg).toFixed(1)}x</span> · gimbal <span className="a-num">{Math.round(drone?.gimbal_pitch_deg ?? 0)}°</span></div>
      </div>
    </div>
  );
}
