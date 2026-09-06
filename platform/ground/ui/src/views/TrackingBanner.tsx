/* Persistent banner shown while autonomous tracking is active. Disengage is
   a plain click, never hold-to-confirm: stopping must be immediate. */
import React from 'react';
import { Square } from 'lucide-react';
import { Badge, Button, StatusPill } from '@/components';

export interface TrackingBannerProps {
  standoff: number;
  maxSpeed: number;
  onDisengage: () => void;
}

const SHELL: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  height: 36, flex: 'none', padding: '0 14px',
  background: 'linear-gradient(90deg, var(--amber-tint), rgba(245,166,35,0.06))',
  borderBottom: '1px solid var(--amber-line)',
};

export function TrackingBanner({ standoff, maxSpeed, onDisengage }: TrackingBannerProps): JSX.Element {
  return (
    <div role="status" aria-live="polite" style={SHELL}>
      <StatusPill status="caution" pulse>Autonomous tracking active</StatusPill>
      <Badge tone="caution" mono>standoff {standoff.toFixed(1)} m</Badge>
      <Badge tone="caution" mono>max {maxSpeed.toFixed(1)} m/s</Badge>
      <Button
        variant="danger"
        size="sm"
        icon={<Square size={12} fill="currentColor" />}
        onClick={onDisengage}
        style={{ marginLeft: 'auto' }}
      >
        Disengage
      </Button>
    </div>
  );
}
