/* PID tuning — a gain table for the yaw, altitude and forward controllers.
   The operator edits free text; the whole table is parsed together and Apply
   stays disabled while any cell fails to parse (non-numeric or negative).
   Applied gains persist through settingsStore and map onto the companion
   config keys guidance.gains.{yaw,altitude,forward}.{kp,ki,kd}. */
import React, { useEffect, useMemo, useReducer, useRef } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Modal, Button, Badge } from '@/components';
import { DEFAULT_SETTINGS, PID_AXES, PID_GAIN_KEYS, settingsStore, useSettings } from '@/store/settings';
import type { PidAxis, PidGainKey, PidGains } from '@/store/settings';

export interface PidTuningModalProps {
  open: boolean;
  onClose: () => void;
}

/** The text form of the gain table — what the operator is editing. */
export type PidDraft = Record<PidAxis, Record<PidGainKey, string>>;
type CellKey = `${PidAxis}.${PidGainKey}`;

export interface PidDraftParse {
  /** The parsed table, or null when any cell is invalid. */
  gains: PidGains | null;
  errors: Partial<Record<CellKey, string>>;
}

const AXIS_LABEL: Record<PidAxis, string> = { yaw: 'Yaw', altitude: 'Altitude', forward: 'Forward' };
const GAIN_LABEL: Record<PidGainKey, string> = { kp: 'Kp', ki: 'Ki', kd: 'Kd' };

export function pidToDraft(gains: PidGains): PidDraft {
  const draft = {} as PidDraft;
  for (const axis of PID_AXES) {
    const row = gains[axis];
    draft[axis] = { kp: String(row.kp), ki: String(row.ki), kd: String(row.kd) };
  }
  return draft;
}

/** Parse every cell; a gain must be a finite number that is not negative. */
export function parsePidDraft(draft: PidDraft): PidDraftParse {
  const errors: PidDraftParse['errors'] = {};
  const gains = {} as PidGains;
  for (const axis of PID_AXES) {
    const row = { kp: 0, ki: 0, kd: 0 };
    for (const key of PID_GAIN_KEYS) {
      const trimmed = (draft[axis]?.[key] ?? '').trim();
      const value = trimmed === '' ? Number.NaN : Number(trimmed);
      if (!Number.isFinite(value)) errors[`${axis}.${key}`] = 'not a number';
      else if (value < 0) errors[`${axis}.${key}`] = 'must be ≥ 0';
      else row[key] = value;
    }
    gains[axis] = row;
  }
  return { gains: Object.keys(errors).length === 0 ? gains : null, errors };
}

type DraftAction =
  | { type: 'load'; gains: PidGains }
  | { type: 'edit'; axis: PidAxis; key: PidGainKey; text: string };

function draftReducer(state: PidDraft, action: DraftAction): PidDraft {
  switch (action.type) {
    case 'load':
      return pidToDraft(action.gains);
    case 'edit':
      return { ...state, [action.axis]: { ...state[action.axis], [action.key]: action.text } };
    default:
      return state;
  }
}

function sameGains(a: PidGains, b: PidGains): boolean {
  return PID_AXES.every((axis) => PID_GAIN_KEYS.every((key) => a[axis][key] === b[axis][key]));
}

const HEAD: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
  textTransform: 'uppercase', color: 'var(--text-tertiary)',
};

export function PidTuningModal({ open, onClose }: PidTuningModalProps): JSX.Element | null {
  const settings = useSettings();
  const [draft, dispatch] = useReducer(draftReducer, settings.pid, pidToDraft);

  // Seed the draft from the persisted gains on the closed → open transition only.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) dispatch({ type: 'load', gains: settings.pid });
    wasOpen.current = open;
  }, [open, settings.pid]);

  const parsed = useMemo(() => parsePidDraft(draft), [draft]);
  const invalidCells = Object.keys(parsed.errors).length;
  const changed = parsed.gains !== null && !sameGains(parsed.gains, settings.pid);

  const apply = (): void => {
    if (!parsed.gains) return;
    settingsStore.set({ pid: parsed.gains });
    onClose();
  };
  const resetDefaults = (): void => dispatch({ type: 'load', gains: DEFAULT_SETTINGS.pid });

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
          <Button variant="ghost" onClick={resetDefaults}>Reset to defaults</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={parsed.gains === null} onClick={apply}>Apply</Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '6px 0 10px' }}>
        <div style={{
          padding: '8px 10px',
          background: 'var(--info-bg)',
          border: '1px solid var(--accent-border)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 11, color: 'var(--accent-text)', lineHeight: 1.5,
        }}>
          When connected, gains are pushed to the companion at{' '}
          <span style={{ fontFamily: 'var(--font-mono)' }}>guidance.gains.&#123;axis&#125;.&#123;kp|ki|kd&#125;</span>.
          Tune carefully — changes take effect immediately on Apply.
        </div>

        <div
          role="table"
          aria-label="PID gains"
          style={{
            display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 1fr', gap: '6px 8px', alignItems: 'center',
            padding: '10px 12px 12px',
            background: 'var(--surface-input)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <span style={HEAD}>Axis</span>
          {PID_GAIN_KEYS.map((key) => <span key={key} style={{ ...HEAD, textAlign: 'right' }}>{GAIN_LABEL[key]}</span>)}

          {PID_AXES.map((axis) => (
            <React.Fragment key={axis}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{AXIS_LABEL[axis]}</span>
                <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  guidance.gains.{axis}
                </span>
              </div>
              {PID_GAIN_KEYS.map((key) => {
                const error = parsed.errors[`${axis}.${key}`];
                return (
                  <input
                    key={key}
                    type="text"
                    inputMode="decimal"
                    aria-label={`${AXIS_LABEL[axis]} ${GAIN_LABEL[key]}`}
                    aria-invalid={error ? true : undefined}
                    title={error}
                    value={draft[axis][key]}
                    onChange={(e) => dispatch({ type: 'edit', axis, key, text: e.target.value })}
                    style={{
                      height: 30, padding: '0 8px', width: '100%', boxSizing: 'border-box',
                      background: 'var(--bg-sunken)',
                      border: `1px solid ${error ? 'var(--red)' : 'var(--border-input)'}`,
                      borderRadius: 'var(--radius-sm)',
                      color: error ? 'var(--red-bright)' : 'var(--text-primary)',
                      fontFamily: 'var(--font-mono)', fontSize: 13, textAlign: 'right', outline: 'none',
                    }}
                  />
                );
              })}
            </React.Fragment>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 18 }}>
          {invalidCells > 0 && (
            <Badge tone="danger">{invalidCells} invalid {invalidCells === 1 ? 'cell' : 'cells'}</Badge>
          )}
          {invalidCells === 0 && changed && <Badge tone="caution">Unapplied changes</Badge>}
          {invalidCells === 0 && !changed && <Badge tone="neutral">Matches persisted gains</Badge>}
        </div>
      </div>
    </Modal>
  );
}
