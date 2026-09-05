import React from 'react';

interface SignalGaugeProps {
  rssi?: number;
  latencyMs?: number | null;
  lost?: boolean;
  label?: string;
  compact?: boolean;
}

type SignalStatus = 'nominal' | 'caution' | 'danger';

/**
 * SignalGauge — link-quality bars driven by RSSI, with latency readout.
 * Degrades to caution/danger as signal drops; shows "LINK LOST" when null.
 */
export function SignalGauge({ rssi = -60, latencyMs = null, lost = false, label = 'Link', compact = false }: SignalGaugeProps) {
  // map rssi (-100 weak .. -40 strong) → 0..4 bars
  const norm = Math.max(0, Math.min(1, (rssi + 100) / 60));
  const bars = lost ? 0 : Math.max(1, Math.ceil(norm * 4));
  const status: SignalStatus = lost ? 'danger' : norm < 0.3 ? 'danger' : norm < 0.55 ? 'caution' : 'nominal';
  const col: Record<SignalStatus, string> = {
    nominal: 'var(--green)',
    caution: 'var(--amber)',
    danger:  'var(--red)',
  };
  const heights = [6, 9, 12, 15];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 15 }}>
        {heights.map((h, i) => (
          <div key={i} style={{
            width: 3.5, height: h, borderRadius: 1,
            background: !lost && i < bars ? col[status] : 'var(--gray-6)',
            opacity: !lost && i < bars ? 1 : 0.5,
            transition: 'background var(--dur-base) var(--ease-out)',
          }} />
        ))}
      </div>
      {!compact && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{label}</span>
          {lost ? (
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--danger-fg)', letterSpacing: '0.04em' }}>LOST</span>
          ) : (
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(rssi)} dBm{latencyMs != null ? ` · ${latencyMs}ms` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
