import React, { useEffect } from 'react';

interface ModalProps {
  open?: boolean;
  title: string;
  subtitle?: string | null;
  icon?: React.ReactNode;
  onClose?: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  tone?: 'default' | 'danger' | 'caution' | 'accent';
  closeOnBackdrop?: boolean;
}

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
}: ModalProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && onClose) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const accentBar: Record<string, string> = {
    default: 'transparent',
    danger: 'var(--red)',
    caution: 'var(--amber)',
    accent: 'var(--accent)',
  };

  const iconBg: Record<string, string> = {
    default: 'var(--accent-subtle)',
    danger: 'var(--red-tint)',
    caution: 'var(--amber-tint)',
    accent: 'var(--accent-subtle)',
  };
  const iconColor: Record<string, string> = {
    default: 'var(--accent-text)',
    danger: 'var(--red-bright)',
    caution: 'var(--amber-bright)',
    accent: 'var(--accent-text)',
  };

  return (
    <div
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget && onClose) onClose();
      }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
        background: 'var(--scrim)',
        backdropFilter: 'blur(2px)',
        animation: 'eis-fade var(--dur-base) var(--ease-out)',
      }}
    >
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
        {accentBar[tone] !== 'transparent' && (
          <div style={{ height: 3, background: accentBar[tone], flex: 'none' }} />
        )}
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '16px 18px 12px' }}>
          {icon && (
            <span style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, flex: 'none', borderRadius: 'var(--radius-sm)',
              background: iconBg[tone],
              color: iconColor[tone],
            }}>
              {icon}
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{
              margin: 0,
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-lg)',
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-primary)',
              letterSpacing: '-0.01em',
            }}>
              {title}
            </h2>
            {subtitle && (
              <p style={{
                margin: '3px 0 0',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-tertiary)',
                lineHeight: 'var(--leading-snug)',
              }}>
                {subtitle}
              </p>
            )}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 26, height: 26, flex: 'none', marginTop: -2, marginRight: -4,
                background: 'transparent', border: 'none', borderRadius: 'var(--radius-sm)',
                color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 18, lineHeight: '1',
              }}
            >
              ×
            </button>
          )}
        </header>
        <div style={{ padding: '0 18px 4px', overflow: 'auto', flex: 1 }}>{children}</div>
        {footer && (
          <footer style={{
            display: 'flex', justifyContent: 'flex-end', gap: 8,
            padding: '14px 18px 16px', marginTop: 8,
            borderTop: '1px solid var(--border-subtle)',
          }}>
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
