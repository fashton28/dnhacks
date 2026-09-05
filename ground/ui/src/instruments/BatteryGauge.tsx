import React from 'react';

interface BatteryGaugeProps {
  remaining?: number;
  voltage?: number | null;
  current?: number | null;
  cells?: number | null;
  compact?: boolean;
}

type BatteryStatus = 'nominal' | 'caution' | 'critical';

/**
 * BatteryGauge — horizontal battery bar with colour-coded remaining %, plus
 * voltage/current readouts. Amber <30%, red <15% (critical pulses via eis-batpulse).
 */
export function BatteryGauge({ remaining = 100, voltage = null, current = null, cells = null, compact = false }: BatteryGaugeProps) {
  const status: BatteryStatus = remaining <= 15 ? 'critical' : remaining <= 30 ? 'caution' : 'nominal';
  const col: Record<BatteryStatus, string> = {
    nominal:  'var(--green)',
    caution:  'var(--amber)',
    critical: 'var(--red)',
  };
  const fg: Record<BatteryStatus, string> = {
    nominal:  'var(--nominal-fg)',
    caution:  'var(--caution-fg)',
    critical: 'var(--danger-fg)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>Battery</span>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 2 }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: compact ? 'var(--text-md)' : 'var(--readout-md)', fontWeight: 500, color: fg[status], fontVariantNumeric: 'tabular-nums' }}>{Math.round(remaining)}</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)' }}>%</span>
        </span>
      </div>

      {/* battery body */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <div style={{ position: 'relative', flex: 1, height: compact ? 8 : 12, background: 'var(--bg-sunken)', border: '1px solid var(--border-input)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${Math.max(2, remaining)}%`,
            background: col[status],
            transition: 'width var(--dur-slow) var(--ease-out), background var(--dur-base) var(--ease-out)',
            animation: status === 'critical' ? 'eis-batpulse 1s ease-in-out infinite' : 'none',
          }} />
        </div>
        <div style={{ width: 3, height: compact ? 4 : 6, background: 'var(--border-input)', borderRadius: '0 2px 2px 0' }} />
      </div>

      {(voltage != null || current != null) && !compact && (
        <div style={{ display: 'flex', gap: 14, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
          {voltage != null && (
            <span style={{ color: 'var(--text-secondary)' }}>
              {voltage.toFixed(1)}<span style={{ color: 'var(--text-disabled)' }}> V</span>
              {cells != null ? <span style={{ color: 'var(--text-disabled)' }}> · {cells}S</span> : null}
            </span>
          )}
          {current != null && (
            <span style={{ color: 'var(--text-secondary)' }}>
              {current.toFixed(1)}<span style={{ color: 'var(--text-disabled)' }}> A</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
