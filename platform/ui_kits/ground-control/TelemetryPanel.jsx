/* TelemetryPanel — right column: artificial horizon, compass, numeric readouts,
   and battery/altitude sparklines. */
function TelemetryPanel({ tel, tracking, history }) {
  const DS = window.dnhacksPlatformDesignSystem_c7577a;
  const { Panel, GaugeReadout, AttitudeIndicator, Compass } = DS;
  const pos = tel?.position || {}; const vel = tel?.velocity || {}; const gps = tel?.gps || {};
  const bat = tel?.battery || {};
  const estDist = tracking?.state === 'locked' ? tracking?.estimatedDistance : null;
  const batStatus = (bat.remaining ?? 100) <= 15 ? 'danger' : (bat.remaining ?? 100) <= 30 ? 'caution' : 'nominal';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0, overflow: 'auto' }}>
      <Panel title="Attitude & heading" pad>
        <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', gap: 8 }}>
          <AttitudeIndicator roll={tel?.attitude?.roll ?? 0} pitch={tel?.attitude?.pitch ?? 0} size={132} label={false} />
          <Compass heading={tel?.heading ?? 0} size={132} label={false} />
        </div>
      </Panel>

      <Panel title="Telemetry">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 10px' }}>
          <GaugeReadout label="Rel Alt" value={(pos.relAlt ?? 0).toFixed(1)} unit="m" size="md" />
          <GaugeReadout label="Ground Spd" value={(vel.groundspeed ?? 0).toFixed(1)} unit="m/s" size="md" />
          <GaugeReadout label="Vert Spd" value={(vel.verticalSpeed ?? 0).toFixed(1)} unit="m/s" size="md" trend={(vel.verticalSpeed ?? 0) > 0.1 ? 'up' : (vel.verticalSpeed ?? 0) < -0.1 ? 'down' : null} />
          <GaugeReadout label="To Home" value={(tel?.home?.distance ?? 0).toFixed(0)} unit="m" size="md" />
          <GaugeReadout label="To Target" value={estDist != null ? estDist.toFixed(1) : '—'} unit={estDist != null ? 'm' : ''} size="md" status={estDist != null ? 'caution' : 'muted'} />
          <GaugeReadout label="Battery" value={(bat.remaining ?? 0).toFixed(0)} unit="%" size="md" status={batStatus} />
        </div>
        <div style={{ height: 1, background: 'var(--border-subtle)', margin: '12px 0' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px 8px' }}>
          <Mini label="Sats" value={gps.satellites ?? '—'} />
          <Mini label="HDOP" value={(gps.hdop ?? 0).toFixed(1)} />
          <Mini label="Voltage" value={`${(bat.voltage ?? 0).toFixed(1)}V`} />
          <Mini label="Lat" value={(pos.lat ?? 0).toFixed(4)} />
          <Mini label="Lon" value={(pos.lon ?? 0).toFixed(4)} span2 />
        </div>
      </Panel>

      <Panel title="History">
        <Spark label="Altitude" data={history.alt} unit="m" color="var(--accent)" />
        <div style={{ height: 10 }} />
        <Spark label="Battery" data={history.bat} unit="%" color={batStatus === 'danger' ? 'var(--red)' : batStatus === 'caution' ? 'var(--amber)' : 'var(--green)'} />
      </Panel>
    </div>
  );
}

function Mini({ label, value, span2 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: span2 ? 'span 2' : 'auto' }}>
      <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function Spark({ label, data, unit, color }) {
  const w = 252, h = 34;
  const vals = data.length ? data : [0];
  const min = Math.min(...vals), max = Math.max(...vals);
  const rng = max - min || 1;
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * w},${h - ((v - min) / rng) * (h - 4) - 2}`).join(' ');
  const last = vals[vals.length - 1];
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
        <span style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{last.toFixed(1)} {unit}</span>
      </div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

Object.assign(window, { TelemetryPanel });
