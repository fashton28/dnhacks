/* Settings modal — connection config, SITL toggle, units, map tiles.
   Backed by settingsStore; reads current AppSettings, writes via settingsStore.set. */
import React, { useState } from 'react';
import { Settings, Shield, SlidersHorizontal } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/Button';
import { Toggle } from '@/components/Toggle';
import { settingsStore, useSettings } from '@/store/settings';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onOpenFailsafe?: () => void;
  onOpenPid?: () => void;
}

/* ---- sub-components -------------------------------------------------------- */

interface FieldProps {
  label: string;
  children: React.ReactNode;
  flex?: boolean;
}

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

interface InputProps {
  value: string;
  onChange?: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
  mono?: boolean;
}

function Input({ value, onChange, disabled, placeholder, mono }: InputProps): JSX.Element {
  return (
    <input
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={e => onChange?.(e.target.value)}
      style={{
        height: 32, padding: '0 10px',
        background: disabled ? 'var(--bg-sunken)' : 'var(--surface-input)',
        border: '1px solid var(--border-input)',
        borderRadius: 'var(--radius-sm)',
        color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: 13, outline: 'none',
        width: '100%', boxSizing: 'border-box',
      }}
    />
  );
}

interface SegmentOption { label: string; value: string }

interface SegmentProps {
  options: SegmentOption[];
  value: string;
  onChange: (v: string) => void;
}

function Segment({ options, value, onChange }: SegmentProps): JSX.Element {
  return (
    <div style={{
      display: 'flex', gap: 2, padding: 2,
      background: 'var(--bg-sunken)',
      borderRadius: 'var(--radius-sm)',
      border: '1px solid var(--border-subtle)',
    }}>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            flex: 1, height: 26, border: 'none', borderRadius: 4,
            background: value === o.value ? 'var(--surface-input)' : 'transparent',
            color: value === o.value ? 'var(--text-primary)' : 'var(--text-tertiary)',
            fontSize: 12, fontWeight: 500, cursor: 'pointer',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---- main component -------------------------------------------------------- */

export function SettingsModal({
  open,
  onClose,
  onOpenFailsafe,
  onOpenPid,
}: SettingsModalProps): JSX.Element | null {
  const settings = useSettings();
  const conn = settings.connection;

  // Local draft so we can batch changes before writing through
  const [draft, setDraft] = useState(() => settings.connection);
  // Reset draft when modal opens
  React.useEffect(() => {
    if (open) setDraft(settings.connection);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchConn = (patch: Partial<typeof conn>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    settingsStore.set(s => ({ ...s, connection: next }));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={460}
      icon={<Settings size={16} />}
      title="Settings"
      subtitle="Connection & display. Persisted via SettingsStore in the live build."
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '6px 0 12px' }}>

        <Field label="Host / Jetson IP">
          <Input
            value={draft.sitl ? 'sitl' : draft.host}
            disabled={draft.sitl}
            onChange={v => patchConn({ host: v })}
          />
        </Field>

        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Control port" flex>
            <Input
              value={String(draft.controlPort)}
              onChange={v => patchConn({ controlPort: Number(v) || 8765 })}
              mono
            />
          </Field>
          <Field label="Video URL" flex>
            <Input
              value={draft.videoUrl}
              placeholder="rtsp:// · empty = mock"
              onChange={v => patchConn({ videoUrl: v })}
              mono
            />
          </Field>
        </div>

        {/* SITL toggle row */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '11px 12px',
          background: 'var(--surface-input)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-subtle)',
        }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>
              SITL simulator
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              Software-in-the-loop — no hardware
            </div>
          </div>
          <Toggle
            checked={draft.sitl}
            onChange={v => patchConn({ sitl: v })}
          />
        </div>

        {/* Units + Map tiles */}
        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Units" flex>
            <Segment
              options={[
                { label: 'Metric', value: 'metric' },
                { label: 'Imperial', value: 'imperial' },
              ]}
              value={settings.units}
              onChange={v => settingsStore.set(s => ({ ...s, units: v as 'metric' | 'imperial' }))}
            />
          </Field>
          <Field label="Map tiles" flex>
            <Segment
              options={[
                { label: 'Satellite', value: 'satellite' },
                { label: 'Terrain', value: 'terrain' },
                { label: 'OSM', value: 'osm' },
              ]}
              value={settings.mapTiles}
              onChange={v => settingsStore.set(s => ({ ...s, mapTiles: v as 'satellite' | 'terrain' | 'osm' }))}
            />
          </Field>
        </div>

        {/* Links to Failsafe & PID modals */}
        {(onOpenFailsafe || onOpenPid) && (
          <div style={{
            display: 'flex', gap: 8, paddingTop: 4,
            borderTop: '1px solid var(--border-subtle)',
            marginTop: 2,
          }}>
            {onOpenFailsafe && (
              <button
                onClick={() => { onClose(); onOpenFailsafe(); }}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  height: 34, background: 'var(--surface-input)',
                  border: '1px solid var(--border-input)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
              >
                <Shield size={13} />
                Failsafe settings
              </button>
            )}
            {onOpenPid && (
              <button
                onClick={() => { onClose(); onOpenPid(); }}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  height: 34, background: 'var(--surface-input)',
                  border: '1px solid var(--border-input)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
                }}
              >
                <SlidersHorizontal size={13} />
                PID tuning
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
