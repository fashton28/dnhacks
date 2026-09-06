/* Failsafe envelope editor — geofence, altitude ceiling, battery thresholds
   and the link-loss / GCS-heartbeat-loss actions. Edits live in a local draft
   until Apply writes the whole block through settingsStore. The companion
   owns the hard envelope; the checks here are advisory and never block. */
import React, { useEffect, useReducer, useRef } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Modal, Button, Slider, Badge } from '@/components';
import { DEFAULT_SETTINGS, SAFETY_ACTIONS, settingsStore, useSettings } from '@/store/settings';
import type { FailsafeConfig, SafetyAction } from '@/store/settings';

export interface FailsafeModalProps {
  open: boolean;
  onClose: () => void;
}

/** The dialog's own editable ranges; the companion re-clamps on its side. */
export const FAILSAFE_RANGES = {
  geofenceRadius:     { min: 20, max: 500, step: 5, unit: 'm' },
  maxAltitude:        { min: 5,  max: 120, step: 1, unit: 'm' },
  batteryWarnPct:     { min: 10, max: 60,  step: 1, unit: '%' },
  batteryFailsafePct: { min: 5,  max: 30,  step: 1, unit: '%' },
} as const;

const ACTION_LABEL: Record<SafetyAction, string> = { HOLD: 'Hold', RTL: 'RTL', LAND: 'Land' };

/** Advisory notes about a draft. Empty means nothing to flag. */
export function failsafeDraftWarnings(draft: FailsafeConfig): string[] {
  const notes: string[] = [];
  if (draft.batteryFailsafePct >= draft.batteryWarnPct) {
    notes.push('Battery failsafe is not below the warn threshold, so the warning can never precede the action.');
  }
  if (draft.linkLossAction === 'HOLD') {
    notes.push('Hold on link loss keeps the vehicle airborne with nobody in control — RTL or Land is safer.');
  }
  return notes;
}

type DraftAction =
  | { type: 'load'; value: FailsafeConfig }
  | { type: 'patch'; value: Partial<FailsafeConfig> };

function draftReducer(state: FailsafeConfig, action: DraftAction): FailsafeConfig {
  switch (action.type) {
    case 'load':
      return { ...action.value };
    case 'patch':
      return { ...state, ...action.value };
    default:
      return state;
  }
}

function sameFailsafe(a: FailsafeConfig, b: FailsafeConfig): boolean {
  return (Object.keys(a) as (keyof FailsafeConfig)[]).every((key) => a[key] === b[key]);
}

const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
  textTransform: 'uppercase', color: 'var(--text-tertiary)',
};

interface PercentFieldProps {
  label: string;
  value: number;
  range: { min: number; max: number; step: number; unit: string };
  onChange: (value: number) => void;
}

function PercentField({ label, value, range, onChange }: PercentFieldProps): JSX.Element {
  return (
    <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={LABEL}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="number"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          onChange={(e) => {
            const next = e.target.valueAsNumber;
            if (Number.isFinite(next)) onChange(next);
          }}
          style={{
            flex: 1, height: 32, padding: '0 10px', width: '100%', boxSizing: 'border-box',
            background: 'var(--surface-input)',
            border: '1px solid var(--border-input)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)', fontSize: 13, outline: 'none',
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{range.unit}</span>
      </span>
    </label>
  );
}

interface ActionPickerProps {
  label: string;
  value: SafetyAction;
  onChange: (action: SafetyAction) => void;
}

function ActionPicker({ label, value, onChange }: ActionPickerProps): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={LABEL}>{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        style={{
          display: 'flex', gap: 2, padding: 2,
          background: 'var(--bg-sunken)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {SAFETY_ACTIONS.map((action) => {
          const selected = action === value;
          return (
            <button
              key={action}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(action)}
              style={{
                flex: 1, height: 26, border: 'none', borderRadius: 4, cursor: 'pointer',
                background: selected ? 'var(--surface-input)' : 'transparent',
                color: selected ? 'var(--text-primary)' : 'var(--text-tertiary)',
                fontSize: 12, fontWeight: 500,
              }}
            >
              {ACTION_LABEL[action]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function FailsafeModal({ open, onClose }: FailsafeModalProps): JSX.Element | null {
  const settings = useSettings();
  const [draft, dispatch] = useReducer(draftReducer, settings.failsafe, (value: FailsafeConfig) => ({ ...value }));

  // Seed the draft from the persisted envelope on the closed → open transition only.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) dispatch({ type: 'load', value: settings.failsafe });
    wasOpen.current = open;
  }, [open, settings.failsafe]);

  const patch = (value: Partial<FailsafeConfig>): void => dispatch({ type: 'patch', value });
  const warnings = failsafeDraftWarnings(draft);
  const changed = !sameFailsafe(draft, settings.failsafe);

  const apply = (): void => {
    settingsStore.set({ failsafe: { ...draft } });
    onClose();
  };
  const resetDefaults = (): void => dispatch({ type: 'load', value: DEFAULT_SETTINGS.failsafe });

  const r = FAILSAFE_RANGES;

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
          <Button variant="ghost" onClick={resetDefaults}>Reset to defaults</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply}>Apply</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '6px 0 10px' }}>
        <Slider
          label="Geofence radius"
          value={draft.geofenceRadius}
          min={r.geofenceRadius.min}
          max={r.geofenceRadius.max}
          step={r.geofenceRadius.step}
          unit={r.geofenceRadius.unit}
          accent="var(--amber)"
          ticks={[`${r.geofenceRadius.min} m`, `${r.geofenceRadius.max} m`]}
          onChange={(v) => patch({ geofenceRadius: v })}
        />

        <Slider
          label="Max altitude"
          value={draft.maxAltitude}
          min={r.maxAltitude.min}
          max={r.maxAltitude.max}
          step={r.maxAltitude.step}
          unit={r.maxAltitude.unit}
          accent="var(--amber)"
          ticks={[`${r.maxAltitude.min} m`, `${r.maxAltitude.max} m`]}
          onChange={(v) => patch({ maxAltitude: v })}
        />

        <div style={{ display: 'flex', gap: 12 }}>
          <PercentField
            label="Battery warn"
            value={draft.batteryWarnPct}
            range={r.batteryWarnPct}
            onChange={(v) => patch({ batteryWarnPct: v })}
          />
          <PercentField
            label="Battery failsafe"
            value={draft.batteryFailsafePct}
            range={r.batteryFailsafePct}
            onChange={(v) => patch({ batteryFailsafePct: v })}
          />
        </div>

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

        <ActionPicker
          label="Link-loss action"
          value={draft.linkLossAction}
          onChange={(v) => patch({ linkLossAction: v })}
        />
        <ActionPicker
          label="GCS heartbeat-loss action"
          value={draft.gcsLossAction}
          onChange={(v) => patch({ gcsLossAction: v })}
        />

        {(warnings.length > 0 || changed) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {changed && <Badge tone="caution" style={{ alignSelf: 'flex-start' }}>Unapplied changes</Badge>}
            {warnings.map((note) => (
              <div key={note} role="note" style={{ fontSize: 11, color: 'var(--caution-fg)', lineHeight: 1.45 }}>
                {note}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
