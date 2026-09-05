import React from 'react';

/**
 * GaugeReadout — a labelled numeric telemetry value with tabular mono figures
 * so digits don't jitter. Optional unit, status colour, and trend caret.
 */
export function GaugeReadout({
  label,
  value,
  unit = '',
  status = 'default',
  size = 'md',
  trend = null,        // 'up' | 'down' | null
  align = 'left',
  style = {},
}) {
  const colors = {
    default:  'var(--text-primary)',
    nominal:  'var(--nominal-fg)',
    caution:  'var(--caution-fg)',
    danger:   'var(--danger-fg)',
    accent:   'var(--accent-text)',
    muted:    'var(--text-tertiary)',
  };
  const sizes = {
    sm: 'var(--readout-sm)',
    md: 'var(--readout-md)',
    lg: 'var(--readout-lg)',
    xl: 'var(--readout-xl)',
  };
  const valColor = colors[status] || colors.default;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: align === 'right' ? 'flex-end' : 'flex-start', ...style }}>
      <span
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-2xs)',
          fontWeight: 'var(--weight-semibold)',
          letterSpacing: 'var(--tracking-label)',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
          lineHeight: 1,
        }}
      >
        {label}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4, lineHeight: 1 }}>
        {trend && (
          <span style={{ color: valColor, fontSize: '0.7em', transform: 'translateY(-1px)' }}>
            {trend === 'up' ? '▲' : '▼'}
          </span>
        )}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: sizes[size],
            fontWeight: 'var(--weight-medium)',
            fontVariantNumeric: 'tabular-nums',
            fontFeatureSettings: "'tnum' 1, 'zero' 1",
            letterSpacing: 'var(--tracking-mono)',
            color: valColor,
          }}
        >
          {value}
        </span>
        {unit && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: size === 'xl' || size === 'lg' ? 'var(--text-sm)' : 'var(--text-2xs)',
              fontWeight: 'var(--weight-medium)',
              color: 'var(--text-tertiary)',
            }}
          >
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}
