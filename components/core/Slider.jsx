import React from 'react';

/**
 * Slider — labelled range control for tuning values (standoff distance, max
 * speed). Shows the live value in mono; fill + thumb track the position.
 */
export function Slider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange,
  disabled = false,
  accent = 'var(--accent)',
  ticks = null,
  style = {},
}) {
  const pct = ((value - min) / (max - min)) * 100;
  const id = React.useId();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, opacity: disabled ? 0.5 : 1, ...style }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <label
          htmlFor={id}
          style={{
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-2xs)',
            fontWeight: 'var(--weight-semibold)',
            letterSpacing: 'var(--tracking-label)',
            textTransform: 'uppercase',
            color: 'var(--text-tertiary)',
          }}
        >
          {label}
        </label>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
            {value}
          </span>
          {unit && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)' }}>{unit}</span>}
        </span>
      </div>

      <div style={{ position: 'relative', height: 20, display: 'flex', alignItems: 'center' }}>
        <div style={{ position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 999, background: 'var(--gray-5)' }} />
        <div style={{ position: 'absolute', left: 0, width: `${pct}%`, height: 4, borderRadius: 999, background: accent }} />
        <div
          style={{
            position: 'absolute',
            left: `calc(${pct}% - 8px)`,
            width: 16, height: 16, borderRadius: '50%',
            background: '#fff',
            border: `4px solid ${accent}`,
            boxShadow: 'var(--shadow-raised)',
            pointerEvents: 'none',
          }}
        />
        <input
          id={id}
          type="range"
          min={min} max={max} step={step} value={value}
          disabled={disabled}
          onChange={(e) => onChange && onChange(Number(e.target.value))}
          style={{ position: 'absolute', left: 0, right: 0, width: '100%', height: 20, margin: 0, opacity: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
        />
      </div>

      {ticks && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-disabled)' }}>
          {ticks.map((t, i) => <span key={i}>{t}</span>)}
        </div>
      )}
    </div>
  );
}
