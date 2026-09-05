import React from 'react';

/**
 * Modal — centred dialog over a scrim, for config (Settings, Failsafe, PID),
 * confirmations, and the pre-flight checklist. Esc / backdrop close.
 */
export function Modal({
  open = true,
  title,
  subtitle = null,
  icon = null,
  onClose,
  children,
  footer = null,
  width = 460,
  tone = 'default',
  closeOnBackdrop = true,
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && onClose) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const accentBar = {
    default: 'transparent',
    danger: 'var(--red)',
    caution: 'var(--amber)',
    accent: 'var(--accent)',
  }[tone];

  return (
    <div
      onMouseDown={(e) => { if (closeOnBackdrop && e.target === e.currentTarget && onClose) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        background: 'var(--scrim)',
        backdropFilter: 'blur(2px)',
        animation: 'eis-fade var(--dur-base) var(--ease-out)',
      }}
    >
      <style>{`@keyframes eis-fade{from{opacity:0}to{opacity:1}}@keyframes eis-rise{from{opacity:0;transform:translateY(8px) scale(.99)}to{opacity:1;transform:none}}`}</style>
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: 'relative',
          width, maxWidth: '100%', maxHeight: '90vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--surface-overlay)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: 'var(--shadow-modal)',
          overflow: 'hidden',
          animation: 'eis-rise var(--dur-slow) var(--ease-out)',
        }}
      >
        {accentBar !== 'transparent' && (
          <div style={{ height: 3, background: accentBar, flex: 'none' }} />
        )}
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '16px 18px 12px' }}>
          {icon && (
            <span style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, flex: 'none', borderRadius: 'var(--radius-sm)',
              background: tone === 'danger' ? 'var(--red-tint)' : tone === 'caution' ? 'var(--amber-tint)' : 'var(--accent-subtle)',
              color: tone === 'danger' ? 'var(--red-bright)' : tone === 'caution' ? 'var(--amber-bright)' : 'var(--accent-text)',
            }}>{icon}</span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>{title}</h2>
            {subtitle && <p style={{ margin: '3px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)', lineHeight: 'var(--leading-snug)' }}>{subtitle}</p>}
          </div>
          {onClose && (
            <button onClick={onClose} aria-label="Close" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26, flex: 'none', marginTop: -2, marginRight: -4,
              background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
              color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 18, lineHeight: 1,
            }}>×</button>
          )}
        </header>
        <div style={{ padding: '0 18px 4px', overflow: 'auto', flex: 1 }}>{children}</div>
        {footer && (
          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 18px 16px', marginTop: 8, borderTop: '1px solid var(--border-subtle)' }}>
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
