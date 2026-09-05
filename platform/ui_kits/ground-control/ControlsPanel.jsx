/* ControlsPanel — left column: flight controls, the prominent Engage Tracking
   safety action, and tuning sliders. */
function ControlsPanel({ tel, tracking, connState, standoff, maxSpeed, onCmd, onSetStandoff, onSetMaxSpeed, onArm, onTakeoff, onEngage, checklistDone }) {
  const DS = window.dnhacksPlatformDesignSystem_c7577a;
  const { Panel, Button, HoldButton, StatusPill, Slider } = DS;
  const Ic = window.EISIcon;
  const armed = tel?.armed;
  const flying = (tel?.position?.relAlt ?? 0) > 0.5;
  const tState = tracking?.state || 'idle';
  const tracking_on = tState !== 'idle';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      {/* FLIGHT */}
      <Panel title="Flight" icon={<Ic d={<><path d="M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 27"/></>} s={13} />}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
          {!armed ? (
            <Button variant="primary" block onClick={onArm}
              icon={<Ic d={<><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></>} s={14} />}>Arm</Button>
          ) : (
            <Button variant="secondary" block onClick={() => onCmd('disarm')}
              icon={<Ic d={<><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8" /></>} s={14} />}>Disarm</Button>
          )}
          <Button variant="secondary" block disabled={!armed || flying} onClick={onTakeoff}
            icon={<Ic d={<><path d="M12 20V8M6 14l6-6 6 6"/></>} s={14} />}>Takeoff</Button>
          <Button variant="secondary" block disabled={!flying} onClick={() => onCmd('land')}
            icon={<Ic d={<><path d="M12 4v12M6 10l6 6 6-6"/></>} s={14} />}>Land</Button>
          <Button variant="secondary" block disabled={!flying} onClick={() => onCmd('rtl')}
            icon={<Ic d={<><path d="M9 10l-5 5 5 5"/><path d="M4 15h11a5 5 0 0 0 5-5V4"/></>} s={14} />}>RTL</Button>
        </div>
        {!checklistDone && !armed && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--caution-fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Ic d={<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></>} s={13} /> Pre-flight checklist required
          </div>
        )}
        <div style={{ marginTop: 9 }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Mode</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
            {['LOITER','GUIDED','ALT_HOLD','POSHOLD','BRAKE'].map(m => (
              <button key={m} onClick={() => onCmd('setMode', { mode: m })} style={{
                padding: '4px 8px', fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 500,
                background: tel?.mode === m ? 'var(--accent-subtle)' : 'var(--surface-input)',
                border: `1px solid ${tel?.mode === m ? 'var(--accent-border)' : 'var(--border-input)'}`,
                color: tel?.mode === m ? 'var(--accent-text)' : 'var(--text-secondary)',
                borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              }}>{m}</button>
            ))}
          </div>
        </div>
      </Panel>

      {/* TRACKING */}
      <Panel title="Person tracking" icon={<Ic d={<><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></>} s={13} />}
        status={<StatusPill size="sm" status={tState==='locked'?'caution':tState==='searching'?'info':tState==='lost'?'danger':'neutral'} pulse={tState==='locked'}>{tState}</StatusPill>}>
        {!tracking_on ? (
          <HoldButton variant="primary" disabled={!flying} hint={flying ? 'Hold to engage' : 'Take off first'}
            icon={<Ic d={<><circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></>} s={17} />}
            onConfirm={onEngage}>Engage Tracking</HoldButton>
        ) : (
          <button onClick={() => onCmd('disengageTracking')} style={{
            display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'center', gap: 8,
            height: 'var(--control-h-xl)', background: 'var(--red-deep)', border: '1px solid var(--red)',
            borderRadius: 'var(--radius-md)', color: '#fff', fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 700,
            cursor: 'pointer', letterSpacing: '0.02em',
          }}>
            <Ic d={<><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></>} s={15} /> Disengage Tracking
          </button>
        )}
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 13 }}>
          <Slider label="Standoff distance" value={standoff} min={2} max={15} step={0.5} unit="m" ticks={['2 m','15 m']} onChange={onSetStandoff} />
          <Slider label="Max speed" value={maxSpeed} min={0.5} max={8} step={0.5} unit="m/s" ticks={['0.5','8']} accent="var(--green)" onChange={onSetMaxSpeed} />
        </div>
      </Panel>
    </div>
  );
}

Object.assign(window, { ControlsPanel });
