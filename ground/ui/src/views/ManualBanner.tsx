/* Persistent banner shown while manual (stick) control is active. */
import React from 'react';
import { CornerUpLeft } from 'lucide-react';

export interface ManualBannerProps {
  onRelease: () => void;
}

export function ManualBanner({ onRelease }: ManualBannerProps): JSX.Element {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      height: 36, flex: 'none', padding: '0 14px',
      background: 'linear-gradient(90deg, var(--blue-tint), rgba(47,129,247,0.05))',
      borderBottom: '1px solid var(--blue-line)',
    }}>
      <span style={{
        display: 'flex', alignItems: 'center', gap: 8,
        color: 'var(--accent-text)', fontWeight: 700,
        fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase',
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: 'var(--accent)',
          animation: 'eis-ping2 1.2s infinite',
        }} />
        Manual control active
      </span>

      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)',
      }}>
        operator has the sticks · STABILIZE
      </span>

      <button
        onClick={onRelease}
        style={{
          marginLeft: 'auto',
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 26, padding: '0 12px',
          background: 'var(--surface-input)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-primary)', fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}
      >
        <CornerUpLeft size={12} />
        Release
      </button>
    </div>
  );
}
