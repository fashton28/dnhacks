import React from 'react';
import { Activity, Gauge } from 'lucide-react';
import { Panel } from '@/components';
import { AttitudeIndicator, Compass } from '@/instruments';
import { useArgus } from '../store';

const Cell = ({ k, v, unit, tone, wide, small }: { k: string; v: React.ReactNode; unit?: string; tone?: 'warn' | 'bad' | 'good'; wide?: boolean; small?: boolean }) => (
  <div className="a-cell" data-tone={tone} data-wide={wide}>
    <div className="a-label">{k}</div>
    <div className="a-val"><span className={small ? 'a-num' : 'a-num-lg'} style={small ? { fontSize: 12 } : undefined}>{v}</span>{unit && <span className="a-unit">{unit}</span>}</div>
  </div>
);

const Spark = ({ data, color, label, unit, fixed }: { data: number[]; color: string; label: string; unit: string; fixed: number }) => {
  const w = 220, h = 30;
  const last = data.length ? data[data.length - 1] : 0;
  let path = '', area = '';
  if (data.length >= 2) {
    const max = Math.max(...data, 1), min = Math.min(...data, 0);
    const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / Math.max(1e-6, max - min)) * (h - 3) - 1.5] as const);
    path = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    area = `${path} L${w},${h} L0,${h} Z`;
  }
  return (
    <div className="a-cell" data-wide="true" style={{ paddingBottom: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="a-label">{label} · 60 s</span>
        <span className="a-num" style={{ fontSize: 12, color }}>{last.toFixed(fixed)}<span className="a-unit">{unit}</span></span>
      </div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block', marginTop: 2 }}>
        {area && <path d={area} fill={color} opacity={0.12} />}
        {path && <path d={path} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
};

export function ArgusTelemetry(): React.ReactElement {
  const tel = useArgus((s) => s.tel);
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const history = useArgus((s) => s.history);
  const refused = !!drone?.message?.startsWith('REFUSED');
  const bat = tel?.battery.soc_pct ?? drone?.battery_pct ?? 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <Panel title="Attitude" icon={<Gauge size={13} />} pad>
        <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '2px 0' }}>
          <AttitudeIndicator roll={tel?.attitude.roll ?? 0} pitch={tel?.attitude.pitch ?? 0} size={108} label={false} />
          <Compass heading={tel?.heading ?? 0} size={108} label={false} />
        </div>
      </Panel>
      <Panel title="Telemetry" icon={<Activity size={13} />} pad scroll style={{ flex: 1, minHeight: 0 }}>
        {!drone ? (
          <div className="a-empty"><div className="a-body">Select a Drone to see its telemetry.</div></div>
        ) : (
          <div className="a-inst">
            <Cell k="Altitude" v={(tel?.position.relAlt ?? drone.alt).toFixed(1)} unit="m" />
            <Cell k="Heading" v={String(Math.round(tel?.heading ?? drone.heading_deg)).padStart(3, '0')} unit="°" />
            <Cell k="Speed" v={(tel?.velocity.groundspeed ?? 0).toFixed(1)} unit="m/s" />
            <Cell k="Climb" v={(tel?.velocity.verticalSpeed ?? 0).toFixed(1)} unit="m/s" />
            <Cell k="Battery" v={bat.toFixed(0)} unit="%" tone={bat <= 15 ? 'bad' : bat <= 30 ? 'warn' : undefined} />
            <Cell k="To pad" v={(tel?.home.distance ?? 0).toFixed(0)} unit="m" />
            <Cell k="Camera" v={`${Math.abs(drone.gimbal_pitch_deg)}`} unit={drone.gimbal_pitch_deg < 0 ? '° up' : drone.gimbal_pitch_deg === 0 ? '° level' : '° down'} />
            <Cell k="Autopilot" v={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{drone.mode || '—'}{drone.armed && <span className="a-chip" style={{ color: 'var(--a-mission)', height: 14, padding: '0 5px', fontSize: 9 }}>armed</span>}</span>} small />
            <Cell k="Position" v={`${drone.lat.toFixed(5)}, ${drone.lon.toFixed(5)}`} small wide />
            <div className="a-cell" data-wide="true" data-tone={refused ? 'bad' : undefined}>
              <div className="a-label">Autopilot message</div>
              <div className="a-num" style={{ fontSize: 11, lineHeight: 1.4, color: refused ? 'var(--a-refused)' : 'var(--text-secondary)', wordBreak: 'break-word', whiteSpace: 'normal' }}>{drone.message || '—'}</div>
            </div>
            <Spark data={history.alt} color="var(--blue-bright)" label="Altitude" unit="m" fixed={1} />
            <Spark data={history.bat} color="var(--amber)" label="Battery" unit="%" fixed={0} />
          </div>
        )}
      </Panel>
    </div>
  );
}
