/* Persistent banner shown while autonomous tracking is active. */
import React from 'react';
import { Square } from 'lucide-react';

export interface TrackingBannerProps {
  standoff: number;
  maxSpeed: number;
  onDisengage: () => void;
}

export function TrackingBanner({ standoff, maxSpeed, onDisengage }: TrackingBannerProps): JSX.Element {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      height: 36, flex: 'none', padding: '0 14px',
      background: 'linear-gradient(90deg, var(--amber-tint), rgba(245,166,35,0.06))',
      borderBottom: '1px solid var(--amber-line)',
    }}>
      <span style={{
        display: 'flex', alignItems: 'center', gap: 8,
        color: 'var(--amber-bright)', fontWeight: 700,
        fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--amber)',
          animation: 'eis-ping2 1.2s infinite',
        }} />
        Autonomous tracking active
      </span>

      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)',
      }}>
        standoff {standoff.toFixed(1)} m · max {maxSpeed.toFixed(1)} m/s
      </span>

      <button
        onClick={onDisengage}
        style={{
          marginLeft: 'auto',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 26, padding: '0 12px',
          background: 'var(--red-deep)',
          border: '1px solid var(--red)',
          borderRadius: 'var(--radius-sm)',
          color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}
      >
        <Square size={12} fill="currentColor" />
        Disengage
      </button>
    </div>
  );
}
