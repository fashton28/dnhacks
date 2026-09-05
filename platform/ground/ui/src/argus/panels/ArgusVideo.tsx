import React from 'react';
import { useArgus } from '../store';

/** The selected Drone's camera as an MJPEG stream from the Hub, with an ARGUS HUD and a stale-signal notice. */
export function ArgusVideo({ hubBase, lastFrameTs }: { hubBase: string; lastFrameTs: number }): React.ReactElement {
  const selected = useArgus((s) => s.selected);
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const [clock, setClock] = React.useState(() => new Date().toLocaleTimeString());
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => { const id = setInterval(() => { setClock(new Date().toLocaleTimeString()); setNow(Date.now()); }, 1000); return () => clearInterval(id); }, []);
  const stale = now - lastFrameTs > 4000;
  const url = selected ? `${hubBase}/drones/${selected}/mjpeg` : '';
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#000', borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--border-default)' }}>
      {url && <img key={url} src={url} alt="Drone view" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
      <div style={{ position: 'absolute', left: 10, top: 8, display: 'flex', gap: 8, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: '#e8eef5', textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}>
        <span style={{ fontWeight: 700 }}>{selected ?? '—'}</span>
        <span>{(drone?.alt ?? 0).toFixed(1)} m</span>
        <span>{(drone?.heading_deg ?? 0).toFixed(0)}°</span>
        <span style={{ color: 'var(--text-tertiary)' }}>gimbal {drone?.gimbal_pitch_deg ?? 45}°</span>
      </div>
      <div style={{ position: 'absolute', right: 10, top: 8, display: 'flex', gap: 8, alignItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, color: '#e8eef5', textShadow: '0 1px 2px rgba(0,0,0,0.9)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: stale ? 'var(--amber-bright)' : 'var(--red-bright)' }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: 'currentColor', animation: stale ? 'none' : 'eis-ping2 1.2s infinite' }} />{stale ? 'NO SIGNAL' : 'LIVE'}
        </span>
        <span>{clock}</span>
      </div>
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 22, height: 22, transform: 'translate(-50%,-50%)', opacity: 0.7 }}>
        <div style={{ position: 'absolute', left: '50%', top: 0, width: 1, height: '100%', background: '#fff', transform: 'translateX(-50%)' }} />
        <div style={{ position: 'absolute', top: '50%', left: 0, height: 1, width: '100%', background: '#fff', transform: 'translateY(-50%)' }} />
      </div>
      {stale && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(8,12,16,0.75)', border: '1px solid var(--border-default)', fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 360, lineHeight: 1.5 }}>
            No frames from the Renderer yet. The embedded World view renders this Drone's camera; if it stays dark, open the ARGUS Console in another tab.
          </div>
        </div>
      )}
    </div>
  );
}
