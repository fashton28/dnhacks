/* GroundControl — the app shell. Subscribes to the mock DataSource, holds UI
   state, wires safety flows (checklist → arm, takeoff/engage confirm, instant
   disarm/disengage), keyboard shortcuts, toasts, and composes every panel. */
function GroundControl() {
  const DS = window.dnhacksPlatformDesignSystem_c7577a;
  const { Toast } = DS;
  const ds = window.EISMock;
  const HOME = { lat: 37.7699, lon: -122.4666 };

  const [tel, setTel] = React.useState(null);
  const [tracking, setTracking] = React.useState(null);
  const [connState, setConnState] = React.useState('connected');
  const [logs, setLogs] = React.useState([]);
  const [toasts, setToasts] = React.useState([]);
  const [history, setHistory] = React.useState({ alt: [], bat: [] });
  const [trail, setTrail] = React.useState([]);
  const [elapsed, setElapsed] = React.useState(0);
  const [recording, setRecording] = React.useState(false);

  const [standoff, setStandoff] = React.useState(4);
  const [maxSpeed, setMaxSpeed] = React.useState(3);
  const [checklistDone, setChecklistDone] = React.useState(false);
  const [modal, setModal] = React.useState(null); // 'checklist'|'takeoff'|'settings'
  const [config, setConfig] = React.useState({ host: '192.168.1.42', controlPort: 8765, videoUrl: '', sitl: true });
  const [manualActive, setManualActive] = React.useState(false);
  const [controllerOn, setControllerOn] = React.useState(false);

  const pushToast = React.useCallback((t) => {
    const id = Math.random();
    setToasts(ts => [...ts, { ...t, id }]);
    setTimeout(() => setToasts(ts => ts.filter(x => x.id !== id)), 4200);
  }, []);

  // subscriptions
  React.useEffect(() => {
    ds.start();
    const offT = ds.onTelemetry(t => setTel(t));
    const offK = ds.onTracking(t => setTracking(t));
    const offC = ds.onConnectionChange(s => setConnState(s));
    const offTxt = ds.onStatusText(s => {
      setLogs(l => [...l.slice(-200), s]);
      if (s.severity === 'critical') pushToast({ severity: 'critical', title: s.text });
    });
    const offAck = ds.onAck(a => {
      if (!a.success) pushToast({ severity: 'error', title: `${a.command} failed`, message: a.message });
    });
    return () => { offT(); offK(); offC(); offTxt(); offAck(); };
  }, [ds, pushToast]);

  // history + trail + flight timer sampling
  React.useEffect(() => {
    const id = setInterval(() => {
      setTel(cur => {
        if (cur) {
          setHistory(h => ({ alt: [...h.alt.slice(-59), cur.position.relAlt], bat: [...h.bat.slice(-59), cur.battery.remaining] }));
          if (cur.position.relAlt > 0.4) setTrail(tr => [...tr.slice(-120), { lat: cur.position.lat, lon: cur.position.lon }]);
          if (cur.armed) setElapsed(e => e + 1);
        }
        return cur;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const cmd = React.useCallback((command, params) => ds.sendCommand({ type: 'command', command, params }), [ds]);

  // safety flows
  const doArm = () => { if (!checklistDone) { setModal('checklist'); return; } cmd('arm'); pushToast({ severity: 'success', title: 'Armed' }); };
  const doTakeoff = () => setModal('takeoff');
  const confirmTakeoff = (alt) => { cmd('takeoff', { altitude: alt }); setModal(null); pushToast({ severity: 'success', title: 'Takeoff acknowledged', message: `Climbing to ${alt} m` }); };
  const doEngage = () => { setManualActive(false); cmd('engageTracking'); cmd('setStandoff', { meters: standoff }); cmd('setMaxSpeed', { mps: maxSpeed }); pushToast({ severity: 'warning', title: 'Tracking engaged', message: `Standoff ${standoff} m` }); };
  const doDisarm = () => { setManualActive(false); cmd('emergencyStop'); pushToast({ severity: 'error', title: 'Disarmed' }); };

  const onStandoff = (v) => { setStandoff(v); cmd('setStandoff', { meters: v }); };
  const onMaxSpeed = (v) => { setMaxSpeed(v); cmd('setMaxSpeed', { mps: v }); };

  // manual (game-controller) piloting
  const doManualEngage = () => { cmd('engageManual'); setManualActive(true); pushToast({ severity: 'warning', title: 'Manual control engaged', message: 'Operator has the sticks' }); };
  const doManualRelease = () => { cmd('disengageManual'); setManualActive(false); pushToast({ severity: 'info', title: 'Manual released', message: 'Position hold' }); };
  const onStickInput = React.useCallback((v) => ds.setManualInput(v), [ds]);

  // keyboard shortcuts
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); doDisarm(); }
      else if (e.key === 't' || e.key === 'T') { if (tracking?.state === 'idle' && (tel?.position?.relAlt ?? 0) > 0.5) doEngage(); }
      else if (e.key === 'd' || e.key === 'D') { if (tracking && tracking.state !== 'idle') cmd('disengageTracking'); }
      else if (e.key === 'r' || e.key === 'R') { if ((tel?.position?.relAlt ?? 0) > 0.5) cmd('rtl'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const trackingActive = tracking && tracking.state !== 'idle';
  const flying = (tel?.position?.relAlt ?? 0) > 0.5;
  const { StatusBar, VideoPanel, ControlsPanel, ManualControl, TelemetryPanel, MapPanel, LogConsole, ChecklistModal, TakeoffModal, SettingsModal, TrackingBanner, ManualBanner } = window;

  return (
    <div className="eis-root" style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-app)', overflow: 'hidden' }}>
      <StatusBar tel={tel} connState={connState} sitl={config.sitl} elapsed={elapsed} controllerOn={controllerOn} manualActive={manualActive} onDisarm={doDisarm} onOpenSettings={() => setModal('settings')} />
      {trackingActive && <TrackingBanner standoff={standoff} maxSpeed={maxSpeed} onDisengage={() => cmd('disengageTracking')} />}
      {manualActive && <ManualBanner onRelease={doManualRelease} />}

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'var(--leftpanel-w) 1fr var(--rightpanel-w)', gap: 10, padding: 10 }}>
        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'auto', paddingRight: 2 }}>
          <ControlsPanel tel={tel} tracking={tracking} connState={connState} standoff={standoff} maxSpeed={maxSpeed}
            onCmd={cmd} onSetStandoff={onStandoff} onSetMaxSpeed={onMaxSpeed} onArm={doArm} onTakeoff={doTakeoff} onEngage={doEngage} checklistDone={checklistDone} />
          <ManualControl armed={!!tel?.armed} flying={flying} manualActive={manualActive}
            onEngage={doManualEngage} onRelease={doManualRelease} onInput={onStickInput} onControllerChange={setControllerOn} />
        </div>

        {/* CENTER */}
        <div style={{ display: 'grid', gridTemplateRows: '1.55fr 1fr', gap: 10, minHeight: 0 }}>
          <div style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--border-default)', minHeight: 0 }}>
            <VideoPanel tracking={tracking} connState={connState} standoff={standoff} onSelectTarget={(id) => cmd('selectTarget', { targetId: id })} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 10, minHeight: 0 }}>
            <MapPanel tel={tel} tracking={tracking} home={HOME} trail={trail} />
            <LogConsole logs={logs} recording={recording} onToggleRecord={() => { setRecording(r => !r); }} />
          </div>
        </div>

        {/* RIGHT */}
        <TelemetryPanel tel={tel} tracking={tracking} history={history} />
      </div>

      {/* toasts */}
      <div style={{ position: 'fixed', top: 56, right: 14, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 1200 }}>
        {toasts.map(t => <Toast key={t.id} severity={t.severity} title={t.title} message={t.message} onDismiss={() => setToasts(ts => ts.filter(x => x.id !== t.id))} />)}
      </div>

      <ChecklistModal open={modal === 'checklist'} onClose={() => setModal(null)} onComplete={() => { setChecklistDone(true); setModal(null); cmd('arm'); pushToast({ severity: 'success', title: 'Checklist complete — Armed' }); }} />
      <TakeoffModal open={modal === 'takeoff'} onClose={() => setModal(null)} onConfirm={confirmTakeoff} defaultAlt={4} />
      <SettingsModal open={modal === 'settings'} onClose={() => setModal(null)} config={config} onChange={(c) => setConfig(p => ({ ...p, ...c }))} />
    </div>
  );
}

Object.assign(window, { GroundControl });
