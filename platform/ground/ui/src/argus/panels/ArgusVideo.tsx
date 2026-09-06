import React from 'react';
import { useArgus, fovToZoom } from '../store';
import { ArgusMark } from '../Brand';
import { GIMBAL_MAX, GIMBAL_MIN } from './OpsPanel';
import { hubHttpBase } from '../../dataSource/hubConfig';

/** The selected Drone's camera as a live Three.js render (the Console in embed-drone mode, no JPEG in the loop), with an avionics HUD and a gimbal ladder. */
export function ArgusVideo({ hubBase, lastFrameTs, onGimbal }: { hubBase: string; lastFrameTs: number; onGimbal: (pitchDeg: number) => void }): React.ReactElement {
  const selected = useArgus((s) => s.selected);
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const gimbalPending = useArgus((s) => s.gimbalPending);
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  // The camera is a live render in the iframe below; signal is judged by telemetry freshness and the frame having loaded.
  const [frameLoaded, setFrameLoaded] = React.useState(false);
  const mountedAt = React.useRef(Date.now());
  const telemetryAge = drone ? now - new Date(drone.ts).getTime() : Infinity;
  const stale = !frameLoaded ? now - mountedAt.current > 8000 : telemetryAge > 4000;
  void lastFrameTs;
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const firstDrone = React.useRef<string | null>(null);
  if (firstDrone.current === null && selected) firstDrone.current = selected;
  const liveUrl = firstDrone.current ? `${hubHttpBase()}/console/?embed=drone&drone=${encodeURIComponent(firstDrone.current)}` : '';
  // The Console echoes every selection it applies; keep asking until the camera confirms it follows the dashboard's selection.
  const [cameraSelected, setCameraSelected] = React.useState<string | null>(null);
  React.useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; drone_id?: unknown } | null;
      if (m && m.type === 'argus-selected' && e.source === frameRef.current?.contentWindow) setCameraSelected(String(m.drone_id));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  React.useEffect(() => {
    if (!selected || cameraSelected === selected) return;
    const post = () => frameRef.current?.contentWindow?.postMessage({ type: 'argus-select', drone_id: selected }, '*');
    post();
    const t = setInterval(post, 500);
    return () => clearInterval(t);
  }, [selected, cameraSelected]);
  void hubBase;
  const gimbal = gimbalPending ?? drone?.gimbal_pitch_deg ?? 45;
  const cam = useArgus((s) => (s.selected ? s.camera[s.selected] : undefined)) ?? { mode: 'rgb', fov_deg: 70 };
  const zoom = fovToZoom(cam.fov_deg);
  const frac = (gimbal - GIMBAL_MIN) / (GIMBAL_MAX - GIMBAL_MIN);
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000', overflow: 'hidden' }}>
      {liveUrl && <iframe ref={frameRef} src={liveUrl} title="Drone camera" onLoad={() => { setFrameLoaded(true); frameRef.current?.contentWindow?.postMessage({ type: 'argus-select', drone_id: selected }, '*'); }} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block', background: '#000' }} />}
      {/* vignette so HUD text stays legible on bright ground */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'linear-gradient(180deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 78%, rgba(0,0,0,0.42) 100%)' }} />

      {/* top-left: identity and pose */}
      <div className="a-hud" style={{ position: 'absolute', left: 12, top: 10, display: 'flex', gap: 12, alignItems: 'baseline' }}>
        <span style={{ fontWeight: 700, fontSize: 12 }}>{selected ?? '—'}</span>
        <span><span className="dim">ALT </span>{(drone?.alt ?? 0).toFixed(1)} m</span>
        <span><span className="dim">HDG </span>{String(Math.round(drone?.heading_deg ?? 0)).padStart(3, '0')}°</span>
        <span><span className="dim">CAM </span>{gimbal}°</span>
        <span><span className="dim">ZOOM </span>{zoom.toFixed(1)}x</span>
      </div>
      {/* top-right: link state */}
      <div className="a-hud" style={{ position: 'absolute', right: 12, top: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
        <span className="a-modetag" data-mode={cam.mode}>{cam.mode === 'rgb' ? 'RGB' : cam.mode === 'thermal' ? 'THERMAL' : 'LIDAR'}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: stale ? 'var(--amber-bright)' : 'var(--red-bright)' }}>
          <span className="a-dot" data-live={!stale} />{stale ? 'NO SIGNAL' : 'LIVE'}
        </span>
        <span className="dim">{drone?.mode || ''}</span>
      </div>
      {/* bottom-left: mode and status */}
      <div className="a-hud" style={{ position: 'absolute', left: 12, bottom: 10, display: 'flex', gap: 12 }}>
        <span><span className="dim">STATUS </span>{(drone?.status ?? '—').replace('_', ' ').toUpperCase()}</span>
        <span><span className="dim">BAT </span>{(drone?.battery_pct ?? 0).toFixed(0)}%</span>
      </div>
      {/* reticle */}
      <svg width="40" height="40" viewBox="-20 -20 40 40" style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', opacity: 0.75, pointerEvents: 'none' }}>
        <g stroke="#fff" strokeWidth="1" fill="none">
          <line x1="-18" y1="0" x2="-7" y2="0" /><line x1="7" y1="0" x2="18" y2="0" />
          <line x1="0" y1="-18" x2="0" y2="-7" /><line x1="0" y1="7" x2="0" y2="18" />
          <circle r="2" />
        </g>
      </svg>
      {/* gimbal ladder: drag or scroll to aim the camera */}
      {selected && (
        <div className="a-hud-gimbal" title="Camera pitch: drag, or keys [ ]" onWheel={(e) => { e.preventDefault(); onGimbal(Math.max(GIMBAL_MIN, Math.min(GIMBAL_MAX, gimbal + (e.deltaY > 0 ? 5 : -5)))); }}>
          <div className="track">
            {[-30, 0, 30, 60, 90].map((d) => <i key={d} style={{ top: `${((d - GIMBAL_MIN) / (GIMBAL_MAX - GIMBAL_MIN)) * 100}%` }} />)}
            <b style={{ top: `${frac * 100}%` }} />
            <input type="range" min={GIMBAL_MIN} max={GIMBAL_MAX} step={1} value={gimbal} onChange={(e) => onGimbal(Number(e.target.value))} aria-label="Gimbal pitch" />
          </div>
          <span className="read">{gimbal > 0 ? `${gimbal}° ↓` : gimbal < 0 ? `${-gimbal}° ↑` : 'LEVEL'}</span>
        </div>
      )}
      {stale && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div className="a-empty" style={{ height: 'auto', padding: '10px 14px', borderRadius: 8, background: 'rgba(8,12,16,0.78)', border: '1px solid var(--border-subtle)', maxWidth: 340 }}>
            <ArgusMark size={26} />
            <div className="a-body"><b>No signal.</b><br />{frameLoaded ? 'Telemetry from this Drone has stopped.' : 'The camera view is still loading.'}</div>
          </div>
        </div>
      )}
    </div>
  );
}
