/* Pre-flight checklist — every item must be confirmed before Arm is enabled.
   The confirmed set is thrown away each time the dialog opens, so a checklist
   walked for an earlier sortie can never satisfy this one. */
import React, { useEffect, useState } from 'react';
import { ClipboardCheck, Check } from 'lucide-react';
import { Modal, Button, Badge } from '@/components';

export interface ChecklistModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: () => void;
}

/** The six checks, in the order the operator walks them. */
export const PREFLIGHT_ITEMS: readonly string[] = [
  'GPS 3D fix acquired (≥ 12 sats)',
  'Battery ≥ 90% & secured',
  'Props clear of obstructions',
  'RC transmitter bound & armed',
  'Geofence configured',
  'Camera & companion link healthy',
];

const NOTHING_CONFIRMED: ReadonlySet<number> = new Set<number>();

interface CheckRowProps {
  index: number;
  label: string;
  done: boolean;
  onToggle: (index: number) => void;
}

function CheckRow({ index, label, done, onToggle }: CheckRowProps): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      onClick={() => onToggle(index)}
      style={{
        display: 'flex', alignItems: 'center', gap: 11, width: '100%',
        padding: '9px 10px', textAlign: 'left',
        borderRadius: 'var(--radius-sm)', cursor: 'pointer',
        background: done ? 'var(--nominal-bg)' : 'var(--surface-input)',
        border: `1px solid ${done ? 'var(--green-line)' : 'var(--border-subtle)'}`,
        color: done ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)', fontSize: 13,
        transition: 'background var(--dur-fast), border-color var(--dur-fast)',
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 18, height: 18, flex: 'none', borderRadius: 4,
          background: done ? 'var(--green)' : 'transparent',
          border: `1.5px solid ${done ? 'var(--green)' : 'var(--border-strong)'}`,
          color: '#04140b',
        }}
      >
        {done && <Check size={12} strokeWidth={3} />}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)' }}>
        {index + 1}
      </span>
    </button>
  );
}

export function ChecklistModal({ open, onClose, onComplete }: ChecklistModalProps): JSX.Element | null {
  const [confirmed, setConfirmed] = useState<ReadonlySet<number>>(NOTHING_CONFIRMED);

  useEffect(() => {
    if (open) setConfirmed(NOTHING_CONFIRMED);
  }, [open]);

  const total = PREFLIGHT_ITEMS.length;
  const done = confirmed.size;
  const complete = done === total;

  const toggle = (index: number): void =>
    setConfirmed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

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
          <Button variant="primary" disabled={!complete} onClick={() => { if (complete) onComplete(); }}>
            Confirm & enable Arm
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 2px 4px' }}>
          <span style={{
            fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: 'var(--text-tertiary)',
          }}>
            Checks
          </span>
          <Badge tone={complete ? 'nominal' : 'neutral'} mono>{done}/{total} confirmed</Badge>
        </div>
        {PREFLIGHT_ITEMS.map((label, i) => (
          <CheckRow key={label} index={i} label={label} done={confirmed.has(i)} onToggle={toggle} />
        ))}
      </div>
    </Modal>
  );
}
