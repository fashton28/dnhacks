import React from 'react';

/**
 * Toast — transient command-ack / alert notification. Maps to CommandAck and
 * critical statusText. Render a stack of these top-right or bottom-centre.
 */
export function Toast({ severity = 'info', title, message = null, icon = null, onDismiss = null, style = {} }) {
  const map = {
    info:     { line: 'var(--accent)', fg: 'var(--accent-text)', bg: 'var(--info-bg)' },
    success:  { line: 'var(--green)', fg: 'var(--nominal-fg)', bg: 'var(--nominal-bg)' },
    warning:  { line: 'var(--amber)', fg: 'var(--caution-fg)', bg: 'var(--caution-bg)' },
    error:    { line: 'var(--red)', fg: 'var(--danger-fg)', bg: 'var(--danger-bg)' },
    critical: { line: 'var(--red-bright)', fg: '#fff', bg: 'var(--red-tint-2)' },
  };
  const c = map[severity] || map.info;

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        width: 320,
        padding: '11px 12px',
        background: 'var(--surface-overlay)',
        border: '1px solid var(--border-default)',
        borderLeft: `3px solid ${c.line}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-popover)',
        animation: 'eis-toast var(--dur-slow) var(--ease-out)',
        ...style,
      }}
    >
      <style>{`@keyframes eis-toast{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}`}</style>
      {icon && (
        <span style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 22, height: 22, flex: 'none', marginTop: 1,
          borderRadius: 'var(--radius-xs)', background: c.bg, color: c.fg,
        }}>{icon}</span>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>{title}</div>
        {message && <div style={{ marginTop: 2, fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 'var(--leading-snug)' }}>{message}</div>}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" style={{
          width: 18, height: 18, flex: 'none', background: 'transparent', border: 'none',
          color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 0,
        }}>×</button>
      )}
    </div>
  );
}
