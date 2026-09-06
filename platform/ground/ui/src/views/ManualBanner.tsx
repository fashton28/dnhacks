/* Persistent banner shown while manual (stick) control is active. Release is
   a plain click that hands the vehicle back to position hold. */
import React from 'react';
import { CornerUpLeft } from 'lucide-react';
import { Badge, Button, StatusPill } from '@/components';

export interface ManualBannerProps {
  onRelease: () => void;
}

const SHELL: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  height: 36, flex: 'none', padding: '0 14px',
  background: 'linear-gradient(90deg, var(--blue-tint), rgba(47,129,247,0.05))',
  borderBottom: '1px solid var(--blue-line)',
};

export function ManualBanner({ onRelease }: ManualBannerProps): JSX.Element {
  return (
    <div role="status" aria-live="polite" style={SHELL}>
      <StatusPill status="info" pulse>Manual control active</StatusPill>
      <Badge tone="neutral" mono>operator has the sticks</Badge>
      <Badge tone="outline">STABILIZE</Badge>
      <Button
        variant="secondary"
        size="sm"
        icon={<CornerUpLeft size={12} />}
        onClick={onRelease}
        style={{ marginLeft: 'auto' }}
      >
        Release
      </Button>
    </div>
  );
}
