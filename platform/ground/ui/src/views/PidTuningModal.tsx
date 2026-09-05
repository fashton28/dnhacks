/* PID tuning modal — edit kp/ki/kd for yaw, altitude, forward controllers.
   Gains map to companion config guidance.gains.{yaw,altitude,forward}.{kp,ki,kd}.
   Persisted via settingsStore. */
import React, { useState, useEffect } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/Button';
import { settingsStore, useSettings, DEFAULT_SETTINGS } from '@/store/settings';
import type { PidGains, PidAxisGains } from '@/store/settings';

export interface PidTuningModalProps {
  open: boolean;
  onClose: () => void;
}

/* ---- gain input row -------------------------------------------------------- */

interface GainInputProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
}

function GainInput({ label, value, onChange }: GainInputProps): JSX.Element {
  const [raw, setRaw] = useState(String(value));

  useEffect(() => {
    setRaw(String(value));
  }, [value]);

  const commit = () => {
    const n = parseFloat(raw);
    if (!Number.isNaN(n) && n >= 0) {
      onChange(n);
    } else {
      setRaw(String(value)); // revert
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{
        fontSize: 10, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}>
        {label}
      </label>
      <input
        type="text"
        inputMode="decimal"
        value={raw}
        onChange={e => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') commit(); }}
        style={{
          height: 32, padding: '0 10px',
          background: 'var(--surface-input)',
          border: '1px solid var(--border-input)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)', fontSize: 13,
          outline: 'none', width: '100%', boxSizing: 'border-box',
          textAlign: 'right',
        }}
      />
    </div>
  );
}

/* ---- axis block ------------------------------------------------------------ */

interface AxisBlockProps {
  axis: string;
  companionKey: string;
  gains: PidAxisGains;
  onChange: (g: PidAxisGains) => void;
}

function AxisBlock({ axis, companionKey, gains, onChange }: AxisBlockProps): JSX.Element {
  return (
    <div style={{
      padding: '12px 12px 14px',
      background: 'var(--surface-input)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{axis}</span>
        <span style={{
          fontSize: 10, color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
        }}>
          guidance.gains.{companionKey}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <GainInput label="Kp" value={gains.kp} onChange={v => onChange({ ...gains, kp: v })} />
        <GainInput label="Ki" value={gains.ki} onChange={v => onChange({ ...gains, ki: v })} />
        <GainInput label="Kd" value={gains.kd} onChange={v => onChange({ ...gains, kd: v })} />
      </div>
    </div>
  );
}

/* ---- main component -------------------------------------------------------- */

export function PidTuningModal({ open, onClose }: PidTuningModalProps): JSX.Element | null {
  const settings = useSettings();
  const [draft, setDraft] = useState<PidGains>(() => settings.pid);

  useEffect(() => {
    if (open) setDraft(settings.pid);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleApply = () => {
    settingsStore.set(s => ({ ...s, pid: draft }));
    onClose();
  };

  const handleReset = () => {
    setDraft(DEFAULT_SETTINGS.pid);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={460}
      icon={<SlidersHorizontal size={16} />}
      title="PID tuning"
      subtitle="Edit controller gains. Click Apply to persist and push to the companion."
      footer={
        <>
          <Button variant="ghost" onClick={handleReset}>Reset to defaults</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleApply}>Apply</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '6px 0 10px' }}>

        {/* Companion mapping note */}
        <div style={{
          padding: '8px 10px',
          background: 'var(--info-bg)',
          border: '1px solid var(--accent-border)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 11, color: 'var(--accent-text)', lineHeight: 1.5,
        }}>
          When connected, gains are pushed to the companion at&nbsp;
          <span style={{ fontFamily: 'var(--font-mono)' }}>guidance.gains.&#123;axis&#125;.&#123;kp|ki|kd&#125;</span>.
          Tune carefully — changes take effect immediately on Apply.
        </div>

        <AxisBlock
          axis="Yaw"
          companionKey="yaw"
          gains={draft.yaw}
          onChange={g => setDraft(d => ({ ...d, yaw: g }))}
        />
        <AxisBlock
          axis="Altitude"
          companionKey="altitude"
          gains={draft.altitude}
          onChange={g => setDraft(d => ({ ...d, altitude: g }))}
        />
        <AxisBlock
          axis="Forward"
          companionKey="forward"
          gains={draft.forward}
          onChange={g => setDraft(d => ({ ...d, forward: g }))}
        />

      </div>
    </Modal>
  );
}
