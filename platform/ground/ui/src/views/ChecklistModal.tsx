/* Pre-flight checklist modal — all 6 items must be checked before Arm is enabled. */
import React, { useState, useEffect } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/Button';

export interface ChecklistModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

const ITEMS = [
  'GPS 3D fix acquired (≥ 12 sats)',
  'Battery ≥ 90% & secured',
  'Props clear of obstructions',
  'RC transmitter bound & armed',
  'Geofence configured',
  'Camera & companion link healthy',
] as const;

export function ChecklistModal({ open, onClose, onComplete }: ChecklistModalProps): JSX.Element | null {
  const [checked, setChecked] = useState<boolean[]>(() => ITEMS.map(() => false));

  useEffect(() => {
    if (open) setChecked(ITEMS.map(() => false));
  }, [open]);

  const all = checked.every(Boolean);

  const toggle = (i: number) =>
    setChecked(c => c.map((v, j) => (j === i ? !v : v)));

  return (
    <Modal
      open={open}
      onClose={onClose}
      tone="accent"
      width={440}
      icon={<ClipboardCheck size={16} />}
      title="Pre-flight checklist"
      subtitle="All items must be confirmed before the vehicle can arm."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!all} onClick={onComplete}>
            Confirm & enable Arm
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0 10px' }}>
        {ITEMS.map((it, i) => (
          <label
            key={i}
            onClick={() => toggle(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 11,
              padding: '9px 10px',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              background: checked[i] ? 'var(--nominal-bg)' : 'var(--surface-input)',
              border: `1px solid ${checked[i] ? 'var(--green-line)' : 'var(--border-subtle)'}`,
              transition: 'all var(--dur-fast)',
            }}
          >
            <span style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 18, height: 18, borderRadius: 4, flex: 'none',
              background: checked[i] ? 'var(--green)' : 'transparent',
              border: `1.5px solid ${checked[i] ? 'var(--green)' : 'var(--border-strong)'}`,
              color: '#04140b',
            }}>
              {checked[i] && (
                <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path d="M5 12l4 4L19 6" />
                </svg>
              )}
            </span>
            <span style={{
              fontSize: 13,
              color: checked[i] ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}>
              {it}
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}
