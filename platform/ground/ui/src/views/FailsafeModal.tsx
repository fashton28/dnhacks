/* Failsafe configuration modal — geofence, altitude, battery thresholds, and
   link-loss / GCS-heartbeat-loss actions. Persisted via settingsStore. */
import React, { useState, useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/Button';
import { settingsStore, useSettings, DEFAULT_SETTINGS } from '@/store/settings';
import type { FailsafeConfig, SafetyAction } from '@/store/settings';

export interface FailsafeModalProps {
  open: boolean;
  onClose: () => void;
}

/* ---- tiny shared sub-components ------------------------------------------- */

interface FieldProps { label: string; children: React.ReactNode; flex?: boolean }
function Field({ label, children, flex }: FieldProps): JSX.Element {
  return (
    <div style={{ flex: flex ? 1 : 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{
        fontSize: 10, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}>
        {label}
      </label>
      {children}
    </div>
  );
}

interface NumberInputProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}
function NumberInput({ value, min, max, step = 1, unit, onChange }: NumberInputProps): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={e => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        style={{
          flex: 1, height: 32, padding: '0 10px',
          background: 'var(--surface-input)',
          border: '1px solid var(--border-input)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)', fontSize: 13,
          outline: 'none', width: '100%', boxSizing: 'border-box',
        }}
      />
      {unit && (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{unit}</span>
      )}
    </div>
  );
}

interface SliderRowProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  accentColor?: string;
  onChange: (v: number) => void;
}
function SliderRow({ value, min, max, step = 1, unit, accentColor = 'var(--accent)', onChange }: SliderRowProps): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor }}
      />
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 15,
        color: 'var(--text-primary)',
        fontVariantNumeric: 'tabular-nums',
        minWidth: 52, textAlign: 'right',
      }}>
        {value}
        {unit && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{unit}</span>}
      </span>
    </div>
  );
}

const SAFETY_ACTIONS: SafetyAction[] = ['HOLD', 'RTL', 'LAND'];

interface ActionSegmentProps {
  value: SafetyAction;
  onChange: (v: SafetyAction) => void;
}
function ActionSegment({ value, onChange }: ActionSegmentProps): JSX.Element {
  const labels: Record<SafetyAction, string> = { HOLD: 'Hold', RTL: 'RTL', LAND: 'Land' };
  return (
    <div style={{
      display: 'flex', gap: 2, padding: 2,
      background: 'var(--bg-sunken)',
      borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border-subtle)',
    }}>
      {SAFETY_ACTIONS.map(a => (
        <button
          key={a}
          onClick={() => onChange(a)}
          style={{
            flex: 1, height: 26, border: 'none', borderRadius: 4,
            background: value === a ? 'var(--surface-input)' : 'transparent',
            color: value === a ? 'var(--text-primary)' : 'var(--text-tertiary)',
            fontSize: 12, fontWeight: 500, cursor: 'pointer',
          }}
        >
          {labels[a]}
        </button>
      ))}
    </div>
  );
}

/* ---- main component -------------------------------------------------------- */

export function FailsafeModal({ open, onClose }: FailsafeModalProps): JSX.Element | null {
  const settings = useSettings();
  const [draft, setDraft] = useState<FailsafeConfig>(() => settings.failsafe);

  useEffect(() => {
    if (open) setDraft(settings.failsafe);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (p: Partial<FailsafeConfig>) => setDraft(d => ({ ...d, ...p }));

  const handleApply = () => {
    settingsStore.set(s => ({ ...s, failsafe: draft }));
    onClose();
  };

  const handleReset = () => {
    setDraft(DEFAULT_SETTINGS.failsafe);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      tone="caution"
      width={460}
      icon={<ShieldAlert size={16} />}
      title="Failsafe settings"
      subtitle="Safety envelopes enforced by the companion. Changes take effect on Apply."
      footer={
        <>
          <Button variant="ghost" onClick={handleReset}>Reset to defaults</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleApply}>Apply</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '6px 0 10px' }}>

        {/* Geofence radius */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'var(--text-tertiary)', marginBottom: 8,
          }}>
            Geofence radius
          </div>
          <SliderRow
            value={draft.geofenceRadius}
            min={20}
            max={500}
            step={5}
            unit=" m"
            accentColor="var(--amber)"
            onChange={v => patch({ geofenceRadius: v })}
          />
        </div>

        {/* Max altitude */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'var(--text-tertiary)', marginBottom: 8,
          }}>
            Max altitude
          </div>
          <SliderRow
            value={draft.maxAltitude}
            min={5}
            max={120}
            step={1}
            unit=" m"
            accentColor="var(--amber)"
            onChange={v => patch({ maxAltitude: v })}
          />
        </div>

        {/* Battery thresholds */}
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Battery warn" flex>
            <NumberInput
              value={draft.batteryWarnPct}
              min={10}
              max={60}
              unit="%"
              onChange={v => patch({ batteryWarnPct: v })}
            />
          </Field>
          <Field label="Battery failsafe" flex>
            <NumberInput
              value={draft.batteryFailsafePct}
              min={5}
              max={30}
              unit="%"
              onChange={v => patch({ batteryFailsafePct: v })}
            />
          </Field>
        </div>

        {/* Hint */}
        <div style={{
          padding: '8px 10px',
          background: 'var(--caution-bg)',
          border: '1px solid var(--amber-line)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 11, color: 'var(--caution-fg)', lineHeight: 1.5,
        }}>
          Warn threshold triggers an audible alert. Failsafe threshold triggers the selected
          link-loss action automatically.
        </div>

        {/* Link-loss action */}
        <Field label="Link-loss action">
          <ActionSegment
            value={draft.linkLossAction}
            onChange={v => patch({ linkLossAction: v })}
          />
        </Field>

        {/* GCS heartbeat-loss action */}
        <Field label="GCS heartbeat-loss action">
          <ActionSegment
            value={draft.gcsLossAction}
            onChange={v => patch({ gcsLossAction: v })}
          />
        </Field>

      </div>
    </Modal>
  );
}
