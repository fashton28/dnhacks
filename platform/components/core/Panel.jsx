import React from 'react';

/**
 * Panel — the core surface container for the GCS. A titled header strip
 * (uppercase micro-label + optional status/actions) over a content body.
 */
export function Panel({
  title,
  icon = null,
  actions = null,
  status = null,
  children,
  pad = true,
  scroll = false,
  variant = 'default',
  bodyStyle = {},
  style = {},
}) {
  const variants = {
    default: { bg: 'var(--surface-panel)', bd: 'var(--border-default)' },
    raised:  { bg: 'var(--surface-raised)', bd: 'var(--border-default)' },
    sunken:  { bg: 'var(--bg-sunken)', bd: 'var(--border-subtle)' },
    flush:   { bg: 'transparent', bd: 'var(--border-subtle)' },
  };
  const v = variants[variant] || variants.default;

  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: v.bg,
        border: `1px solid ${v.bd}`,
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {(title || actions || status) && (
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: 34,
            flex: 'none',
            padding: '0 10px 0 12px',
            borderBottom: '1px solid var(--border-subtle)',
            background: 'rgba(255,255,255,0.015)',
          }}
        >
          {icon && <span style={{ color: 'var(--text-tertiary)', display: 'flex' }}>{icon}</span>}
          {title && (
            <span
              style={{
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-2xs)',
                fontWeight: 'var(--weight-semibold)',
                letterSpacing: 'var(--tracking-label)',
                textTransform: 'uppercase',
                color: 'var(--text-secondary)',
              }}
            >
              {title}
            </span>
          )}
          {status && <span style={{ marginLeft: 2 }}>{status}</span>}
          {actions && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>{actions}</div>}
        </header>
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          padding: pad ? 'var(--pad-panel-sm)' : 0,
          overflow: scroll ? 'auto' : 'visible',
          ...bodyStyle,
        }}
      >
        {children}
      </div>
    </section>
  );
}
