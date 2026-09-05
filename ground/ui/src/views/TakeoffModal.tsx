/* Takeoff confirmation modal — altitude slider + hold-to-confirm. */
import React, { useState, useEffect } from 'react';
import { ArrowUp } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { HoldButton } from '@/components/HoldButton';

export interface TakeoffModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (alt: number) => void;
  defaultAlt?: number;
}

export function TakeoffModal({
  open,
  onClose,
  onConfirm,
  defaultAlt = 4,
}: TakeoffModalProps): JSX.Element | null {
  const [alt, setAlt] = useState(defaultAlt);

  useEffect(() => {
    if (open) setAlt(defaultAlt);
  }, [open, defaultAlt]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      tone="caution"
      width={400}
      icon={<ArrowUp size={16} />}
      title="Confirm takeoff"
      subtitle="The vehicle will arm-climb to the set altitude in GUIDED mode."
      footer={null}
    >
      <div style={{ padding: '4px 0 12px' }}>
        <label style={{
          fontSize: 10, fontWeight: 600,
          letterSpacing: '0.06em', textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}>
          Target altitude
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, marginBottom: 16 }}>
          <input
            type="range"
            min={2}
            max={30}
            step={1}
            value={alt}
            onChange={e => setAlt(Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--amber)' }}
          />
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 22,
            color: 'var(--text-primary)',
            fontVariantNumeric: 'tabular-nums',
            minWidth: 64, textAlign: 'right',
          }}>
            {alt}
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}> m</span>
          </span>
        </div>

        <HoldButton
          variant="caution"
          hint="Hold to take off"
          onConfirm={() => onConfirm(alt)}
          icon={<ArrowUp size={16} />}
        >
          Takeoff · {alt} m
        </HoldButton>

        <button
          onClick={onClose}
          style={{
            width: '100%', marginTop: 8, height: 32,
            background: 'transparent', border: 'none',
            color: 'var(--text-tertiary)', fontSize: 12, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </Modal>
  );
}
