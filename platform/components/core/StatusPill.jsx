import React from 'react';

/**
 * StatusPill — the core glanceable status chip used everywhere in the GCS.
 * A coloured dot (optionally pulsing) + uppercase micro-label.
 */
export function StatusPill({
  status = 'neutral',
  children,
  pulse = false,
  size = 'md',
  solid = false,
  dot = true,
  icon = null,
  style = {},
}) {
  const map = {
    nominal:  { fg: 'var(--nominal-fg)',  dot: 'var(--nominal)',  bg: 'var(--nominal-bg)',  line: 'var(--green-line)' },
    caution:  { fg: 'var(--caution-fg)',  dot: 'var(--caution)',  bg: 'var(--caution-bg)',  line: 'var(--amber-line)' },
    danger:   { fg: 'var(--danger-fg)',   dot: 'var(--danger)',   bg: 'var(--danger-bg)',   line: 'var(--red-line)' },
    critical: { fg: '#fff',               dot: '#fff',            bg: 'var(--red)',         line: 'var(--red)' },
    info:     { fg: 'var(--accent-text)', dot: 'var(--accent)',   bg: 'var(--info-bg)',     line: 'var(--blue-line)' },
    active:   { fg: 'var(--accent-text)', dot: 'var(--accent)',   bg: 'var(--info-bg)',     line: 'var(--blue-line)' },
    neutral:  { fg: 'var(--text-secondary)', dot: 'var(--inactive)', bg: 'rgba(255,255,255,0.05)', line: 'var(--border-default)' },
  };
  const c = map[status] || map.neutral;
  const sized = size === 'sm'
    ? { h: 18, fs: 'var(--text-2xs)', px: 7, gap: 5, d: 6 }
    : { h: 22, fs: 'var(--text-xs)', px: 9, gap: 6, d: 7 };

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: sized.gap,
        height: sized.h,
        padding: `0 ${sized.px}px`,
        borderRadius: 'var(--radius-pill)',
        background: solid ? c.dot : c.bg,
        border: `1px solid ${solid ? 'transparent' : c.line}`,
        color: solid ? (status === 'caution' ? '#1a1205' : '#fff') : c.fg,
        fontFamily: 'var(--font-sans)',
        fontSize: sized.fs,
        fontWeight: 'var(--weight-semibold)',
        letterSpacing: 'var(--tracking-label)',
        textTransform: 'uppercase',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dot && !icon && (
        <span style={{ position: 'relative', width: sized.d, height: sized.d, flex: 'none' }}>
          <span style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            background: solid ? '#fff' : c.dot,
          }} />
          {pulse && (
            <span style={{
              position: 'absolute', inset: 0, borderRadius: '50%',
              background: solid ? '#fff' : c.dot,
              animation: 'eis-ping 1.4s var(--ease-out) infinite',
            }} />
          )}
          <style>{`@keyframes eis-ping{0%{transform:scale(1);opacity:.7}70%,100%{transform:scale(2.6);opacity:0}}`}</style>
        </span>
      )}
      {icon}
      {children}
    </span>
  );
}
