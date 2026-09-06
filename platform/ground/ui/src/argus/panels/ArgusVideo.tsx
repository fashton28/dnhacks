import React from 'react';
import { useArgus, fovToZoom } from '../store';
import { ArgusMark } from '../Brand';
import { GIMBAL_MAX, GIMBAL_MIN } from './OpsPanel';
import { hubHttpBase } from '../../dataSource/hubConfig';
import { DroneSound } from '@/lib/droneSound';
import { Volume2, VolumeX } from 'lucide-react';

const SOUND_KEY = 'argus.gcs.sound';

const TAPE_H = 420;
const fmtHeading = (deg: number): string => {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  return d === 0 ? 'N' : d === 90 ? 'E' : d === 180 ? 'S' : d === 270 ? 'W' : String(d).padStart(3, '0');
};

/**
 * The selected Drone's camera as a live Three.js render (the Console in embed-drone mode, no JPEG in the loop),
 * with avionics over it: heading strip, altitude and speed, an altitude tape carrying the Safety Validator's ceiling,
 * reticle, gimbal ladder and link state.
 */
/** The live camera iframe, once mounted: the dashboard posts optimistic gimbal and zoom targets to it so the picture
 *  moves on the key press instead of a Hub round trip later. */
let cameraFrame: HTMLIFrameElement | null = null;
export function postToCameraFrame(message: Record<string, unknown>): void {
  cameraFrame?.contentWindow?.postMessage(message, '*');
}

export function ArgusVideo({ hubBase, lastFrameTs, onGimbal }: { hubBase: string; lastFrameTs: number; onGimbal: (pitchDeg: number) => void }): React.ReactElement {
  const selected = useArgus((s) => s.selected);
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const tel = useArgus((s) => s.tel);
  const gimbalPending = useArgus((s) => s.gimbalPending);
  const manualActive = useArgus((s) => s.manualActive);
  const manualPhase = useArgus((s) => s.manualPhase);
  const sightings = useArgus((s) => s.sightings);
  const boxHost = React.useRef<HTMLDivElement | null>(null);
  const [boxSize, setBoxSize] = React.useState({ w: 0, h: 0 });
  React.useEffect(() => { const el = boxHost.current; if (!el) return; const ro = new ResizeObserver(() => setBoxSize({ w: el.clientWidth, h: el.clientHeight })); ro.observe(el); setBoxSize({ w: el.clientWidth, h: el.clientHeight }); return () => ro.disconnect(); }, []);
  const ceiling = useArgus((s) => s.envelope?.ceiling_m ?? s.missionSpec?.max_altitude_m ?? null);
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  // The camera is a live render in the iframe below; signal is judged by telemetry freshness and the frame having loaded.
  const [frameLoaded, setFrameLoaded] = React.useState(false);
  const mountedAt = React.useRef(Date.now());
  const telemetryAge = drone ? now - new Date(drone.ts).getTime() : Infinity;
  const stale = !frameLoaded ? now - mountedAt.current > 8000 : telemetryAge > 4000;
  void lastFrameTs; void hubBase;
  const frameRef = React.useRef<HTMLIFrameElement | null>(null);
  const firstDrone = React.useRef<string | null>(null);
  if (firstDrone.current === null && selected) firstDrone.current = selected;
  const liveUrl = firstDrone.current ? `${hubHttpBase()}/console/?embed=drone&drone=${encodeURIComponent(firstDrone.current)}` : '';
  // The Console echoes every selection it applies; keep asking until the camera confirms it follows the dashboard's selection.
  const [cameraSelected, setCameraSelected] = React.useState<string | null>(null);
  // rotor sound: lives only while this view is mounted, so the Operator hears the aircraft only from its own perspective
  const sound = React.useRef<DroneSound | null>(null);
  const [muted, setMuted] = React.useState<boolean>(() => { try { return localStorage.getItem(SOUND_KEY) === 'off'; } catch { return false; } });
  const [audioLive, setAudioLive] = React.useState(false);
  React.useEffect(() => {
    const ds = new DroneSound(); ds.start(); ds.setMuted(muted); sound.current = ds;
    const id = setInterval(() => setAudioLive(ds.running), 500);
    return () => { clearInterval(id); ds.stop(); sound.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => { sound.current?.setMuted(muted); try { localStorage.setItem(SOUND_KEY, muted ? 'off' : 'on'); } catch { /* private mode */ } }, [muted]);
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

  const gimbal = gimbalPending ?? drone?.gimbal_pitch_deg ?? 8;
  const cam = useArgus((s) => (s.selected ? s.camera[s.selected] : undefined)) ?? { mode: 'rgb', fov_deg: 70 };
  const zoom = fovToZoom(cam.fov_deg);
  const frac = (gimbal - GIMBAL_MIN) / (GIMBAL_MAX - GIMBAL_MIN);
  const alt = tel?.position.relAlt ?? drone?.alt ?? 0;
  const speed = tel?.velocity.groundspeed ?? (drone ? Math.hypot(drone.velocity_ned.vx, drone.velocity_ned.vy) : 0);
  const heading = tel?.heading ?? drone?.heading_deg ?? 0;
  const bat = tel?.battery.soc_pct ?? drone?.battery_pct ?? 0;
  React.useEffect(() => { sound.current?.update({ armed: !!drone?.armed && !stale, alt, speed, climb: tel?.velocity.verticalSpeed ?? (drone ? -drone.velocity_ned.vz : 0) }); }, [drone?.armed, alt, speed, stale, tel?.velocity.verticalSpeed, drone]);
  // altitude tape: 0 at the bottom, the scale grows with the ceiling or the Drone, in 10 m steps
  const tapeMax = Math.max(50, Math.ceil(((ceiling ?? 0) * 1.25) / 10) * 10, Math.ceil((alt * 1.2) / 10) * 10);
  const yOf = (v: number) => TAPE_H - (Math.max(0, Math.min(tapeMax, v)) / tapeMax) * TAPE_H;
  const ticks: number[] = []; for (let v = 0; v <= tapeMax; v += 5) ticks.push(v);
  const labelEvery = tapeMax <= 60 ? 25 : tapeMax <= 120 ? 50 : 100;
  const hud: React.CSSProperties = { position: 'absolute', pointerEvents: 'none' };

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000', overflow: 'hidden' }}>
      {liveUrl && <iframe ref={(el) => { frameRef.current = el; cameraFrame = el; }} src={liveUrl} title="Drone camera" onLoad={() => { setFrameLoaded(true); frameRef.current?.contentWindow?.postMessage({ type: 'argus-select', drone_id: selected }, '*'); }} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, display: 'block', background: '#000' }} />}
      <div className="a-shade" />

      {/* what the vision model saw in the last frame: boxes scaled from frame pixels to the panel, for a few seconds */}
      <div ref={boxHost} style={{ ...hud, inset: 0 }}>
        {sightings && sightings.drone_id === selected && now - sightings.ts < 6000 && boxSize.w > 0 && sightings.sightings.map((s) => {
          const sx = boxSize.w / (sightings.width || 1280), sy = boxSize.h / (sightings.height || 720);
          const [x0, y0, x1, y1] = s.bbox; const hot = typeof s.temp_max_c === 'number' && s.temp_max_c >= 100;
          return (
            <div key={s.id} className="a-sight" data-hot={hot} style={{ left: x0 * sx, top: y0 * sy, width: Math.max(8, (x1 - x0) * sx), height: Math.max(8, (y1 - y0) * sy) }}>
              <span>{s.label.replace(/_/g, ' ')} {Math.round(s.confidence * 100)}%{typeof s.temp_max_c === 'number' ? ` · ${s.temp_max_c.toFixed(0)} °C` : ''}{typeof s.range_m === 'number' ? ` · ${s.range_m.toFixed(0)} m` : ''}</span>
            </div>
          );
        })}
      </div>

      {/* heading strip */}
      <div style={{ ...hud, left: '50%', top: 78, transform: 'translateX(-50%)', width: 420, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
        <div className="a-hud" style={{ display: 'flex', justifyContent: 'space-between', width: 420, fontSize: 10 }}>
          {[-30, -15, 0, 15, 30].map((o) => <span key={o} className={o === 0 ? '' : 'dim'} style={o === 0 ? { fontWeight: 700, fontSize: 12, color: '#fff' } : undefined}>{fmtHeading(heading + o)}</span>)}
        </div>
        <div style={{ position: 'relative', width: 420, height: 10, borderTop: '1px solid rgba(255,255,255,0.55)' }}>
          {[0, 105, 209, 314, 419].map((x, i) => <span key={x} style={{ position: 'absolute', left: x, top: i === 2 ? -3 : -1, width: i === 2 ? 2 : 1, height: i === 2 ? 12 : 6, background: i === 2 ? '#fff' : 'rgba(255,255,255,0.7)' }} />)}
        </div>
        <span className="a-hud" style={{ fontSize: 12 }}>HDG <b>{String(Math.round(heading) % 360).padStart(3, '0')}</b>°</span>
      </div>

      {/* primary readouts */}
      <div style={{ ...hud, left: 124, top: '40%', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span className="a-hud-unit">Altitude AGL</span><div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}><span className="a-hud-big">{alt.toFixed(1)}</span><span className="a-hud-unit">m</span></div></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}><span className="a-hud-unit">Ground speed</span><div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}><span className="a-hud-big" style={{ fontSize: 30 }}>{speed.toFixed(1)}</span><span className="a-hud-unit">m/s</span></div></div>
        <div className="a-hud" style={{ display: 'flex', gap: 16 }}><span><span className="dim">BAT </span>{bat.toFixed(0)}%</span><span><span className="dim">GIMBAL </span>{gimbal}°</span><span><span className="dim">FOV </span>{Math.round(cam.fov_deg)}°</span><span><span className="dim">ZOOM </span>{zoom.toFixed(1)}x</span></div>
      </div>

      {/* reticle */}
      <svg width="44" height="44" viewBox="-22 -22 44 44" style={{ ...hud, left: '50%', top: '50%', transform: 'translate(-50%,-50%)', opacity: 0.8 }}>
        <g stroke="#fff" strokeWidth="1" fill="none"><line x1="-20" y1="0" x2="-8" y2="0" /><line x1="8" y1="0" x2="20" y2="0" /><line x1="0" y1="-20" x2="0" y2="-8" /><line x1="0" y1="8" x2="0" y2="20" /><circle r="2" /></g>
      </svg>

      {/* altitude tape with the Validator's ceiling */}
      <div style={{ ...hud, right: 118, top: '50%', transform: 'translateY(-50%)', width: 120, height: TAPE_H }}>
        <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,0.55)' }} />
        {ticks.map((v) => <span key={v} className="a-hud-tick" data-major={v % 10 === 0} style={{ top: yOf(v) }} />)}
        {ticks.filter((v) => v % labelEvery === 0).map((v) => <span key={`l${v}`} className="a-hud" style={{ position: 'absolute', right: 22, top: yOf(v) - 5, fontSize: 10 }}>{v}</span>)}
        {ceiling !== null && (
          <div style={{ position: 'absolute', right: -8, top: yOf(ceiling) - 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="a-hud" style={{ color: 'var(--amber-bright)', fontSize: 10, letterSpacing: '0.08em' }}>CEILING {ceiling} m</span><span style={{ width: 26, height: 2, background: 'var(--amber-bright)' }} />
          </div>
        )}
        <div style={{ position: 'absolute', right: -8, top: yOf(alt) - 12, display: 'flex', alignItems: 'center', gap: 6, transition: 'top 300ms var(--ease-out)' }}>
          <span className="a-num" style={{ padding: '4px 8px', borderRadius: 4, fontSize: 13, fontWeight: 600, color: '#fff', background: 'rgba(11,13,17,0.8)', border: '1px solid rgba(255,255,255,0.10)' }}>{alt.toFixed(1)}</span><span style={{ width: 26, height: 2, background: '#fff' }} />
        </div>
      </div>

      {/* top-right: link state */}
      <div className="a-hud" style={{ ...hud, right: 20, top: 80, display: 'flex', gap: 10, alignItems: 'center' }}>
        <span className="a-modetag" data-mode={cam.mode}>{cam.mode === 'rgb' ? 'RGB' : cam.mode === 'thermal' ? 'THERMAL' : 'LIDAR'}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: stale ? 'var(--amber-bright)' : 'var(--red-bright)' }}><span className="a-dot" data-live={!stale} />{stale ? 'NO SIGNAL' : 'LIVE'}</span>
        <span className="dim">{drone?.mode || ''}</span>
        <button className="a-icobtn" onClick={() => setMuted((m) => !m)} style={{ pointerEvents: 'auto', width: 24, height: 24, background: 'rgba(11,13,17,0.6)', color: muted ? 'var(--text-tertiary)' : audioLive ? 'var(--text-primary)' : 'var(--amber-bright)' }} title={muted ? 'Rotor sound off' : audioLive ? 'Rotor sound on' : 'Rotor sound: click anywhere once so the browser allows audio'} aria-pressed={!muted} aria-label="Rotor sound">{muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</button>
      </div>

      {/* gimbal ladder: drag or scroll to aim the camera */}
      {selected && (
        <div className="a-hud-gimbal" style={{ right: 24 }} title="Camera pitch: drag, or keys [ ]" onWheel={(e) => { e.preventDefault(); onGimbal(Math.max(GIMBAL_MIN, Math.min(GIMBAL_MAX, gimbal + (e.deltaY > 0 ? 5 : -5)))); }}>
          <div className="track">
            {[-30, 0, 30, 60, 90].map((d) => <i key={d} style={{ top: `${((d - GIMBAL_MIN) / (GIMBAL_MAX - GIMBAL_MIN)) * 100}%` }} />)}
            <b style={{ top: `${frac * 100}%` }} />
            <input type="range" min={GIMBAL_MIN} max={GIMBAL_MAX} step={1} value={gimbal} onChange={(e) => onGimbal(Number(e.target.value))} aria-label="Gimbal pitch" />
          </div>
          <span className="read">{gimbal > 0 ? `${gimbal}° ↓` : gimbal < 0 ? `${-gimbal}° ↑` : 'LEVEL'}</span>
        </div>
      )}
      {manualActive && manualPhase && manualPhase !== 'live' && (
        <div style={{ ...hud, left: '50%', top: '62%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <span className="a-hud" style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--amber-bright)' }}>{manualPhase.toUpperCase()}</span>
          <span className="a-hud dim" style={{ fontSize: 11 }}>The autopilot holds the sticks until it is airborne</span>
        </div>
      )}
      {stale && (
        <div style={{ ...hud, inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="a-empty a-glass" style={{ height: 'auto', padding: '10px 14px', maxWidth: 340 }}>
            <ArgusMark size={26} />
            <div className="a-body"><b>No signal.</b><br />{frameLoaded ? 'Telemetry from this Drone has stopped.' : 'The camera view is still loading.'}</div>
          </div>
        </div>
      )}
    </div>
  );
}
