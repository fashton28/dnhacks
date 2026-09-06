/* Takeoff confirmation — choose a target altitude, then hold to confirm.
   The altitude is re-seeded from `defaultAlt` every time the dialog opens and
   is always snapped onto the dialog's range, so the value handed to
   `onConfirm` is one the slider could show. */
import React, { useEffect, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { Modal, Button, Slider, HoldButton } from '@/components';

export interface TakeoffModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (alt: number) => void;
  defaultAlt?: number;
}

/** Altitudes the dialog offers, metres AGL. */
export const TAKEOFF_ALT_RANGE = { min: 2, max: 30, step: 1 } as const;

/** Snap any requested altitude onto the dialog's range and step. */
export function clampTakeoffAltitude(alt: number): number {
  const { min, max, step } = TAKEOFF_ALT_RANGE;
  if (!Number.isFinite(alt)) return min;
  const snapped = Math.round((alt - min) / step) * step + min;
  return Math.min(max, Math.max(min, snapped));
}

const QUICK_PICKS: readonly number[] = [3, 4, 6, 10];

export function TakeoffModal({
  open,
  onClose,
  onConfirm,
  defaultAlt = 4,
}: TakeoffModalProps): JSX.Element | null {
  const [alt, setAlt] = useState(() => clampTakeoffAltitude(defaultAlt));

  useEffect(() => {
    if (open) setAlt(clampTakeoffAltitude(defaultAlt));
  }, [open, defaultAlt]);

  const choose = (value: number): void => setAlt(clampTakeoffAltitude(value));
  const { min, max, step } = TAKEOFF_ALT_RANGE;

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0 12px' }}>
        <Slider
          label="Target altitude"
          value={alt}
          min={min}
          max={max}
          step={step}
          unit="m"
          accent="var(--amber)"
          ticks={[`${min} m`, `${max} m`]}
          onChange={choose}
        />

        <div style={{ display: 'flex', gap: 6 }} aria-label="Quick altitudes">
          {QUICK_PICKS.map((value) => {
            const selected = alt === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => choose(value)}
                style={{
                  flex: 1, height: 26, cursor: 'pointer',
                  borderRadius: 'var(--radius-sm)',
                  background: selected ? 'var(--amber-tint)' : 'var(--surface-input)',
                  border: `1px solid ${selected ? 'var(--amber-line)' : 'var(--border-subtle)'}`,
                  color: selected ? 'var(--amber-bright)' : 'var(--text-secondary)',
                  fontFamily: 'var(--font-mono)', fontSize: 12,
                }}
              >
                {value} m
              </button>
            );
          })}
        </div>

        <HoldButton
          variant="caution"
          hint="Hold to take off"
          icon={<ArrowUp size={16} />}
          onConfirm={() => onConfirm(alt)}
        >
          Takeoff · {alt} m
        </HoldButton>

        <Button variant="ghost" block onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}
