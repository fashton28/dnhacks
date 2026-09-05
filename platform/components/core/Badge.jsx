import React from 'react';

/** Badge — compact count / tag label. Lighter than StatusPill, no dot. */
export function Badge({ children, tone = 'neutral', mono = false, style = {} }) {
  const tones = {
    neutral: { bg: 'rgba(255,255,255,0.06)', fg: 'var(--text-secondary)', bd: 'var(--border-default)' },
    accent:  { bg: 'var(--accent-subtle)', fg: 'var(--accent-text)', bd: 'var(--accent-border)' },
    nominal: { bg: 'var(--nominal-bg)', fg: 'var(--nominal-fg)', bd: 'var(--green-line)' },
    caution: { bg: 'var(--caution-bg)', fg: 'var(--caution-fg)', bd: 'var(--amber-line)' },
    danger:  { bg: 'var(--danger-bg)', fg: 'var(--danger-fg)', bd: 'var(--red-line)' },
    outline: { bg: 'transparent', fg: 'var(--text-tertiary)', bd: 'var(--border-strong)' },
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 18,
        padding: '0 6px',
        borderRadius: 'var(--radius-xs)',
        background: t.bg,
        border: `1px solid ${t.bd}`,
        color: t.fg,
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: 'var(--text-2xs)',
        fontWeight: 'var(--weight-semibold)',
        letterSpacing: mono ? 0 : '0.04em',
        textTransform: mono ? 'none' : 'uppercase',
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
