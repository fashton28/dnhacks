/* LogConsole — scrolling statusText stream, colour-coded by severity,
   filterable, with flight-recording controls. */
function LogConsole({ logs, recording, onToggleRecord }) {
  const DS = window.dnhacksPlatformDesignSystem_c7577a;
  const { Panel, Tabs, Badge } = DS;
  const Ic = window.EISIcon;
  const [filter, setFilter] = React.useState('all');
  const scrollRef = React.useRef(null);

  const filtered = logs.filter(l => filter === 'all' ? true : filter === 'warn' ? (l.severity === 'warning' || l.severity === 'error' || l.severity === 'critical') : l.severity === filter);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, filter]);

  const sevColor = { info: 'var(--text-tertiary)', warning: 'var(--caution-fg)', error: 'var(--danger-fg)', critical: 'var(--danger-fg)' };
  const sevTag = { info: 'INFO', warning: 'WARN', error: 'ERR ', critical: 'CRIT' };

  return (
    <Panel title="Event log" pad={false}
      status={<Badge tone="neutral" mono>{logs.length}</Badge>}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tabs size="sm" value={filter} onChange={setFilter} items={[{ id: 'all', label: 'All' }, { id: 'warn', label: 'Alerts' }, { id: 'info', label: 'Info' }]} />
          <button onClick={onToggleRecord} title={recording ? 'Stop recording' : 'Start recording'} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px',
            background: recording ? 'var(--red-tint)' : 'var(--surface-input)',
            border: `1px solid ${recording ? 'var(--red-line)' : 'var(--border-input)'}`,
            borderRadius: 'var(--radius-sm)', color: recording ? 'var(--danger-fg)' : 'var(--text-secondary)',
            fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
          }}>
            <span style={{ width: 8, height: 8, borderRadius: recording ? 2 : '50%', background: recording ? 'var(--red)' : 'var(--text-tertiary)' }} />
            {recording ? 'REC' : 'Record'}
          </button>
        </div>
      }
      style={{ height: '100%' }}>
      <div ref={scrollRef} style={{ height: '100%', overflow: 'auto', padding: '6px 0', fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.65 }}>
        {filtered.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, padding: '1px 12px', alignItems: 'baseline', background: l.severity === 'critical' ? 'var(--red-tint)' : 'transparent' }}>
            <span style={{ color: 'var(--text-disabled)', flex: 'none', fontVariantNumeric: 'tabular-nums' }}>{fmtClock(l.ts)}</span>
            <span style={{ color: sevColor[l.severity], fontWeight: 600, flex: 'none', letterSpacing: '0.04em' }}>{sevTag[l.severity]}</span>
            <span style={{ color: l.severity === 'info' ? 'var(--text-secondary)' : sevColor[l.severity] }}>{l.text}</span>
          </div>
        ))}
        {filtered.length === 0 && <div style={{ padding: '8px 12px', color: 'var(--text-disabled)' }}>No events.</div>}
      </div>
    </Panel>
  );
}
function fmtClock(ts){const d=new Date(ts);return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;}

Object.assign(window, { LogConsole });
