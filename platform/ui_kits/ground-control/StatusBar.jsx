/* StatusBar — always-visible top bar: connection, armed, mode, timer, battery,
   GPS, link, and the persistent DISARM / KILL button at the far right. */
function StatusBar({ tel, connState, sitl, elapsed, controllerOn, manualActive, onDisarm, onOpenSettings }) {
  const { StatusPill, Badge, IconButton } = window.dnhacksPlatformDesignSystem_c7577a;
  const { BatteryGauge, SignalGauge } = window.dnhacksPlatformDesignSystem_c7577a;
  const b = tel?.battery?.remaining ?? 100;
  const armed = tel?.armed;
  const connected = connState === 'connected';
  const fixLabel = ['NO GPS','NO FIX','2D','3D','DGPS','RTK','RTK'][tel?.gps?.fixType ?? 0] || '3D';

  const Sep = () => <div style={{ width: 1, height: 22, background: 'var(--border-subtle)' }} />;

  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 14, height: 'var(--statusbar-h)', flex: 'none',
      padding: '0 12px', background: 'var(--surface-raised)', borderBottom: '1px solid var(--border-default)',
    }}>
      <img src="../../assets/logo-mark.svg" width="24" height="24" alt="" style={{ flex: 'none' }} />

      <StatusPill status={connected ? 'nominal' : connState === 'connecting' ? 'caution' : 'danger'} dot pulse={connState==='connecting'}>
        {connected ? 'Connected' : connState === 'connecting' ? 'Connecting' : 'Disconnected'}
      </StatusPill>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: -6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
          {sitl ? 'sitl' : (tel ? '192.168.1.42' : '—')}
        </span>
        <Badge tone={sitl ? 'caution' : 'nominal'}>{sitl ? 'SITL' : 'LIVE'}</Badge>
      </span>

      <Sep />
      <StatusPill status={armed ? 'danger' : 'neutral'} solid={armed}>{armed ? 'Armed' : 'Disarmed'}</StatusPill>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--accent-text)' }}>{tel?.mode || 'LOITER'}</span>

      <Sep />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, gap: 2 }}>
        <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>FLIGHT</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{fmtTime(elapsed)}</span>
      </div>

      <Sep />
      <div style={{ width: 116 }}><BatteryGauge remaining={b} voltage={tel?.battery?.voltage} compact /></div>

      <Sep />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, gap: 2 }}>
        <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>GPS · {fixLabel}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{tel?.gps?.satellites ?? '—'} sats</span>
      </div>

      <Sep />
      <SignalGauge rssi={tel?.link?.rssi ?? -60} latencyMs={tel?.link?.latencyMs} lost={!connected} />

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span title={manualActive ? 'Manual control active' : controllerOn ? 'Controller connected' : 'No controller'} style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 9px',
          background: manualActive ? 'var(--accent-subtle)' : 'var(--surface-input)',
          border: `1px solid ${manualActive ? 'var(--accent-border)' : 'var(--border-input)'}`,
          borderRadius: 'var(--radius-sm)',
          color: manualActive ? 'var(--accent-text)' : controllerOn ? 'var(--nominal-fg)' : 'var(--text-tertiary)',
          fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
        }}>
          <Ic d={<><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M7 11h3M8.5 9.5v3"/><circle cx="16" cy="10.5" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="13" r="1" fill="currentColor" stroke="none"/></>} s={15} />
          {manualActive ? 'MANUAL' : controllerOn ? 'PAD' : 'NO PAD'}
        </span>
        <IconButton icon={<Ic d={<><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5.5 5.5l2 2M16.5 16.5l2 2M18.5 5.5l-2 2M7.5 16.5l-2 2"/></>} s={16} />} title="Settings" onClick={onOpenSettings} variant="solid" />
        <button onClick={onDisarm} title="Disarm / Kill (Space)" style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, height: 34, padding: '0 16px',
          background: armed ? 'var(--red-deep)' : 'var(--surface-input)',
          border: `1px solid ${armed ? 'var(--red)' : 'var(--border-input)'}`,
          borderRadius: 'var(--radius-md)', color: armed ? '#fff' : 'var(--text-secondary)',
          fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 700, letterSpacing: '0.04em',
          cursor: 'pointer', boxShadow: armed ? 'var(--glow-critical)' : 'none',
          transition: 'all var(--dur-base) var(--ease-out)',
        }}>
          <Ic d={<><path d="M18.36 6.64A9 9 0 1 1 5.64 6.64"/><line x1="12" y1="2" x2="12" y2="12"/></>} s={15} />
          DISARM
        </button>
      </div>
    </header>
  );
}

function Ic({ d, s = 16 }) {
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
}
function fmtTime(s){const m=Math.floor(s/60),ss=s%60;return `${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;}

Object.assign(window, { StatusBar, EISIcon: Ic });
