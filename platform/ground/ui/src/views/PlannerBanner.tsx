/* Persistent banner shown while a planned mission is executing
   (telemetry controlSource === 'planner'). Abort is instant (plain button,
   never hold-to-confirm — stopping must be immediate). */
import React from 'react';
import { Square } from 'lucide-react';

export interface PlannerBannerProps {
  requestId: string | null;
  onAbort: () => void;
}

export function PlannerBanner({ requestId, onAbort }: PlannerBannerProps): JSX.Element {
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
        Planned mission executing
      </span>

      {requestId && (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
          {requestId}
        </span>
      )}

      <button
        onClick={onAbort}
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
        Abort plan
      </button>
    </div>
  );
}
