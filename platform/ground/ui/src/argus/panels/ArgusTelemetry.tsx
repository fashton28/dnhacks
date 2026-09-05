import React from 'react';
import { Panel } from '@/components';
import { AttitudeIndicator, Compass } from '@/instruments';
import { useArgus } from '../store';

const Cell = ({ k, v, warn, wide }: { k: string; v: React.ReactNode; warn?: boolean; wide?: boolean }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0, gridColumn: wide ? '1 / -1' : undefined }}>
    <span style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{k}</span>
    <span className="eis-readout" style={{ fontSize: 13, color: warn ? 'var(--amber-bright)' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
  </div>
);

const Spark = ({ data, color }: { data: number[]; color: string }) => {
  const w = 220, h = 26;
  if (data.length < 2) return <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" />;
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / Math.max(1e-6, max - min)) * (h - 2) - 1}`).join(' ');
  return <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"><polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} /></svg>;
};

export function ArgusTelemetry(): React.ReactElement {
  const tel = useArgus((s) => s.tel);
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const history = useArgus((s) => s.history);
  const refused = !!drone?.message?.startsWith('REFUSED');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <Panel title="Attitude & heading" pad>
        <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
          <AttitudeIndicator roll={tel?.attitude.roll ?? 0} pitch={tel?.attitude.pitch ?? 0} size={104} label={false} />
          <Compass heading={tel?.heading ?? 0} size={104} label={false} />
        </div>
      </Panel>
      <Panel title="Telemetry" pad scroll style={{ flex: 1, minHeight: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 10px' }}>
          <Cell k="Altitude" v={`${(tel?.position.relAlt ?? 0).toFixed(1)} m`} />
          <Cell k="Heading" v={`${(tel?.heading ?? 0).toFixed(0)}°`} />
          <Cell k="Ground speed" v={`${(tel?.velocity.groundspeed ?? 0).toFixed(1)} m/s`} />
          <Cell k="Vertical speed" v={`${(tel?.velocity.verticalSpeed ?? 0).toFixed(1)} m/s`} />
          <Cell k="Battery" v={`${(tel?.battery.soc_pct ?? 0).toFixed(0)} %`} warn={(tel?.battery.soc_pct ?? 100) <= 30} />
          <Cell k="To home" v={`${(tel?.home.distance ?? 0).toFixed(0)} m`} />
          <Cell k="Autopilot" v={`${drone?.mode || '—'}${drone?.armed ? ' · armed' : ''}`} />
          <Cell k="Status" v={drone?.status.replace('_', ' ') ?? '—'} />
          <Cell k="Gimbal" v={`${drone?.gimbal_pitch_deg ?? 45}° down`} />
          <Cell k="Position" v={tel ? `${tel.position.lat.toFixed(5)}, ${tel.position.lon.toFixed(5)}` : '—'} wide />
        </div>
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Autopilot message</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: refused ? 'var(--red-bright)' : 'var(--amber-bright)', lineHeight: 1.4, wordBreak: 'break-word' }}>{drone?.message || '—'}</div>
        </div>
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Altitude · 60 s</div>
          <Spark data={history.alt} color="var(--blue-bright)" />
          <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Battery · 60 s</div>
          <Spark data={history.bat} color="var(--amber)" />
        </div>
      </Panel>
    </div>
  );
}
