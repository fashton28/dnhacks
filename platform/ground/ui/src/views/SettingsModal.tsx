/* Settings — connection (host, control port, video URL, SITL), units and map
   tiles. Text fields commit on blur / Enter and are flushed when the dialog
   closes by any route; every commit is written straight through
   settingsStore, so the rest of the app — and the Electron settings file —
   see it immediately. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Settings, Shield, SlidersHorizontal } from 'lucide-react';
import { Modal, Button, Toggle } from '@/components';
import { MAP_TILE_SETS, UNIT_SYSTEMS, settingsStore, useSettings } from '@/store/settings';
import type { MapTileSet, UnitSystem } from '@/store/settings';
import type { ConnectionConfig } from '@/contract';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onOpenFailsafe?: () => void;
  onOpenPid?: () => void;
}

export const DEFAULT_CONTROL_PORT = 8765;

/** Operator-typed port text → a usable port; anything else falls back. */
export function parseControlPort(input: string, fallback: number = DEFAULT_CONTROL_PORT): number {
  const trimmed = input.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return fallback;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : fallback;
}

/* ---- commit-on-blur text fields with a close-time flush ------------------ */

type Flush = () => void;
type Register = (name: string, flush: Flush | null) => void;

function useFlushRegistry(): { register: Register; flushAll: Flush } {
  const flushes = useRef(new Map<string, Flush>());
  const register = useCallback<Register>((name, flush) => {
    if (flush) flushes.current.set(name, flush);
    else flushes.current.delete(name);
  }, []);
  const flushAll = useCallback(() => {
    for (const flush of Array.from(flushes.current.values())) flush();
  }, []);
  return { register, flushAll };
}

const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
  textTransform: 'uppercase', color: 'var(--text-tertiary)',
};

function Field({ label, children, grow }: { label: string; children: React.ReactNode; grow?: boolean }): JSX.Element {
  return (
    <div style={{ flex: grow ? 1 : 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={LABEL}>{label}</span>
      {children}
    </div>
  );
}

interface TextFieldProps {
  name: string;
  value: string;
  onCommit: (text: string) => void;
  register: Register;
  disabled?: boolean;
  placeholder?: string;
  mono?: boolean;
}

function TextField({ name, value, onCommit, register, disabled, placeholder, mono }: TextFieldProps): JSX.Element {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);

  const commitRef = useRef<Flush>(() => undefined);
  commitRef.current = () => {
    if (text === value) return;
    onCommit(text);
    setText(value); // the prop catches up if the commit produced a new value
  };
  useEffect(() => {
    register(name, () => commitRef.current());
    return () => register(name, null);
  }, [name, register]);

  return (
    <input
      aria-label={name}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => commitRef.current()}
      onKeyDown={(e) => { if (e.key === 'Enter') commitRef.current(); }}
      style={{
        height: 32, padding: '0 10px', width: '100%', boxSizing: 'border-box',
        background: disabled ? 'var(--bg-sunken)' : 'var(--surface-input)',
        border: '1px solid var(--border-input)',
        borderRadius: 'var(--radius-sm)',
        color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: 13, outline: 'none',
      }}
    />
  );
}

interface SegmentedProps<T extends string> {
  name: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (value: T) => void;
}

function Segmented<T extends string>({ name, options, labels, value, onChange }: SegmentedProps<T>): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={name}
      style={{
        display: 'flex', gap: 2, padding: 2,
        background: 'var(--bg-sunken)',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {options.map((option) => {
        const selected = option === value;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option)}
            style={{
              flex: 1, height: 26, border: 'none', borderRadius: 4, cursor: 'pointer',
              background: selected ? 'var(--surface-input)' : 'transparent',
              color: selected ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontSize: 12, fontWeight: 500,
            }}
          >
            {labels[option]}
          </button>
        );
      })}
    </div>
  );
}

const UNIT_LABEL: Record<UnitSystem, string> = { metric: 'Metric', imperial: 'Imperial' };
const TILE_LABEL: Record<MapTileSet, string> = { satellite: 'Satellite', terrain: 'Terrain', osm: 'OSM' };

const LINK: React.CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  height: 34, background: 'var(--surface-input)',
  border: '1px solid var(--border-input)', borderRadius: 'var(--radius-sm)',
  color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer',
};

/* ---- main component -------------------------------------------------------- */

export function SettingsModal({
  open,
  onClose,
  onOpenFailsafe,
  onOpenPid,
}: SettingsModalProps): JSX.Element | null {
  const settings = useSettings();
  const conn = settings.connection;
  const { register, flushAll } = useFlushRegistry();

  /** Merge over the store's CURRENT connection, not this render's copy. */
  const patchConnection = useCallback((patch: Partial<ConnectionConfig>) => {
    settingsStore.set({ connection: { ...settingsStore.get().connection, ...patch } });
  }, []);

  const close = useCallback(() => {
    flushAll();
    onClose();
  }, [flushAll, onClose]);

  const jumpTo = (target?: () => void) => () => {
    close();
    target?.();
  };

  return (
    <Modal
      open={open}
      onClose={close}
      width={460}
      icon={<Settings size={16} />}
      title="Settings"
      subtitle="Connection & display. Every change is written through to the settings store."
      footer={<Button variant="primary" onClick={close}>Done</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '6px 0 12px' }}>

        <Field label="Host / Jetson IP">
          <TextField
            name="host"
            value={conn.sitl ? 'sitl' : conn.host}
            disabled={conn.sitl}
            register={register}
            onCommit={(v) => patchConnection({ host: v.trim() })}
          />
        </Field>

        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Control port" grow>
            <TextField
              name="controlPort"
              mono
              value={String(conn.controlPort)}
              register={register}
              onCommit={(v) => patchConnection({ controlPort: parseControlPort(v) })}
            />
          </Field>
          <Field label="Video URL" grow>
            <TextField
              name="videoUrl"
              mono
              value={conn.videoUrl}
              placeholder="rtsp:// · empty = mock"
              register={register}
              onCommit={(v) => patchConnection({ videoUrl: v.trim() })}
            />
          </Field>
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '11px 12px',
          background: 'var(--surface-input)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-subtle)',
        }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 500 }}>SITL simulator</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Software-in-the-loop — no hardware</div>
          </div>
          <Toggle checked={conn.sitl} onChange={(v) => patchConnection({ sitl: v })} />
        </div>

        <div style={{ display: 'flex', gap: 12 }}>
          <Field label="Units" grow>
            <Segmented
              name="Units"
              options={UNIT_SYSTEMS}
              labels={UNIT_LABEL}
              value={settings.units}
              onChange={(units) => settingsStore.set({ units })}
            />
          </Field>
          <Field label="Map tiles" grow>
            <Segmented
              name="Map tiles"
              options={MAP_TILE_SETS}
              labels={TILE_LABEL}
              value={settings.mapTiles}
              onChange={(mapTiles) => settingsStore.set({ mapTiles })}
            />
          </Field>
        </div>

        {(onOpenFailsafe || onOpenPid) && (
          <div style={{ display: 'flex', gap: 8, paddingTop: 4, marginTop: 2, borderTop: '1px solid var(--border-subtle)' }}>
            {onOpenFailsafe && (
              <button type="button" onClick={jumpTo(onOpenFailsafe)} style={LINK}>
                <Shield size={13} />
                Failsafe settings
              </button>
            )}
            {onOpenPid && (
              <button type="button" onClick={jumpTo(onOpenPid)} style={LINK}>
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
