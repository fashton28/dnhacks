/* Modals & banners — pre-flight checklist (gates Arm), takeoff confirm,
   settings, the persistent tracking-active banner, and critical alerts. */
const DSM = () => window.dnhacksPlatformDesignSystem_c7577a;

function ChecklistModal({ open, onClose, onComplete }) {
  const { Modal, Button } = DSM();
  const Ic = window.EISIcon;
  const items = [
    'GPS 3D fix acquired (≥ 12 sats)', 'Battery ≥ 90% & secured',
    'Props clear of obstructions', 'RC transmitter bound & armed',
    'Geofence configured', 'Camera & companion link healthy',
  ];
  const [checked, setChecked] = React.useState(() => items.map(() => false));
  React.useEffect(() => { if (open) setChecked(items.map(() => false)); }, [open]);
  const all = checked.every(Boolean);

  return (
    <Modal open={open} onClose={onClose} tone="accent" width={440}
      icon={<Ic d={<><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></>} s={16} />}
      title="Pre-flight checklist" subtitle="All items must be confirmed before the vehicle can arm."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!all} onClick={onComplete}>Confirm & enable Arm</Button></>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0 10px' }}>
        {items.map((it, i) => (
          <label key={i} onClick={() => setChecked(c => c.map((v, j) => j === i ? !v : v))}
            style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: checked[i] ? 'var(--nominal-bg)' : 'var(--surface-input)', border: `1px solid ${checked[i] ? 'var(--green-line)' : 'var(--border-subtle)'}`, transition: 'all var(--dur-fast)' }}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, borderRadius: 4, flex: 'none', background: checked[i] ? 'var(--green)' : 'transparent', border: `1.5px solid ${checked[i] ? 'var(--green)' : 'var(--border-strong)'}`, color: '#04140b' }}>
              {checked[i] && <Ic d={<path d="M5 12l4 4L19 6"/>} s={12} />}
            </span>
            <span style={{ fontSize: 13, color: checked[i] ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{it}</span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

function TakeoffModal({ open, onClose, onConfirm, defaultAlt = 4 }) {
  const { Modal, Button, HoldButton } = DSM();
  const Ic = window.EISIcon;
  const [alt, setAlt] = React.useState(defaultAlt);
  React.useEffect(() => { if (open) setAlt(defaultAlt); }, [open, defaultAlt]);
  return (
    <Modal open={open} onClose={onClose} tone="caution" width={400}
      icon={<Ic d={<><path d="M12 20V8M6 14l6-6 6 6"/></>} s={16} />}
      title="Confirm takeoff" subtitle="The vehicle will arm-climb to the set altitude in GUIDED mode."
      footer={null}>
      <div style={{ padding: '4px 0 12px' }}>
        <label style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Target altitude</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, marginBottom: 16 }}>
          <input type="range" min={2} max={30} step={1} value={alt} onChange={e => setAlt(Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--amber)' }} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 22, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', minWidth: 64, textAlign: 'right' }}>{alt}<span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}> m</span></span>
        </div>
        <HoldButton variant="caution" hint="Hold to take off" onConfirm={() => onConfirm(alt)}
          icon={<Ic d={<><path d="M12 20V8M6 14l6-6 6 6"/></>} s={16} />}>Takeoff · {alt} m</HoldButton>
        <button onClick={onClose} style={{ width: '100%', marginTop: 8, height: 32, background: 'transparent', border: 'none', color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
      </div>
    </Modal>
  );
}

function SettingsModal({ open, onClose, config, onChange }) {
  const { Modal, Button, Toggle } = DSM();
  const Ic = window.EISIcon;
  return (
    <Modal open={open} onClose={onClose} width={460}
      icon={<Ic d={<><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5.5 5.5l2 2M16.5 16.5l2 2M18.5 5.5l-2 2M7.5 16.5l-2 2"/></>} s={16} />}
      title="Settings" subtitle="Connection & display. Persisted via SettingsStore in the live build."
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '6px 0 12px' }}>
        <Field label="Host / Jetson IP"><Input value={config.sitl ? 'sitl' : config.host} disabled={config.sitl} onChange={v => onChange({ host: v })} /></Field>
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Control port" flex><Input value={String(config.controlPort)} onChange={v => onChange({ controlPort: Number(v) || 8765 })} mono /></Field>
          <Field label="Video URL" flex><Input value={config.videoUrl} placeholder="rtsp:// · empty = mock" onChange={v => onChange({ videoUrl: v })} mono /></Field>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 12px', background: 'var(--surface-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
          <div><div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>SITL simulator</div><div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Software-in-the-loop — no hardware</div></div>
          <Toggle checked={config.sitl} onChange={v => onChange({ sitl: v })} />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Units" flex><Segment options={['Metric', 'Imperial']} value="Metric" /></Field>
          <Field label="Map tiles" flex><Segment options={['Satellite', 'Terrain']} value="Satellite" /></Field>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children, flex }) {
  return <div style={{ flex: flex ? 1 : 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
    <label style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{label}</label>
    {children}
  </div>;
}
function Input({ value, onChange, disabled, placeholder, mono }) {
  return <input value={value} disabled={disabled} placeholder={placeholder} onChange={e => onChange && onChange(e.target.value)}
    style={{ height: 32, padding: '0 10px', background: disabled ? 'var(--bg-sunken)' : 'var(--surface-input)', border: '1px solid var(--border-input)', borderRadius: 'var(--radius-sm)', color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)', fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)', fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box' }} />;
}
function Segment({ options, value }) {
  const [v, setV] = React.useState(value);
  return <div style={{ display: 'flex', gap: 2, padding: 2, background: 'var(--bg-sunken)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-subtle)' }}>
    {options.map(o => <button key={o} onClick={() => setV(o)} style={{ flex: 1, height: 26, border: 'none', borderRadius: 4, background: v === o ? 'var(--surface-input)' : 'transparent', color: v === o ? 'var(--text-primary)' : 'var(--text-tertiary)', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>{o}</button>)}
  </div>;
}

function TrackingBanner({ standoff, maxSpeed, onDisengage }) {
  const Ic = window.EISIcon;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 36, flex: 'none', padding: '0 14px', background: 'linear-gradient(90deg, var(--amber-tint), rgba(245,166,35,0.06))', borderBottom: '1px solid var(--amber-line)' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--amber-bright)', fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--amber)', animation: 'eis-ping2 1.2s infinite' }} />
        <style>{`@keyframes eis-ping2{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
        Autonomous tracking active
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>standoff {standoff.toFixed(1)} m · max {maxSpeed.toFixed(1)} m/s</span>
      <button onClick={onDisengage} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 12px', background: 'var(--red-deep)', border: '1px solid var(--red)', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
        <Ic d={<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>} s={12} /> Disengage
      </button>
    </div>
  );
}

Object.assign(window, { ChecklistModal, TakeoffModal, SettingsModal, TrackingBanner, ManualBanner });

function ManualBanner({ onRelease }) {
  const Ic = window.EISIcon;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 36, flex: 'none', padding: '0 14px', background: 'linear-gradient(90deg, var(--blue-tint), rgba(47,129,247,0.05))', borderBottom: '1px solid var(--blue-line)' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent-text)', fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--accent)', animation: 'eis-ping2 1.2s infinite' }} />
        Manual control active
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>operator has the sticks · STABILIZE</span>
      <button onClick={onRelease} style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 12px', background: 'var(--surface-input)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
        <Ic d={<><path d="M9 10l-5 5 5 5"/><path d="M4 15h11a5 5 0 0 0 5-5V4"/></>} s={12} /> Release
      </button>
    </div>
  );
}
