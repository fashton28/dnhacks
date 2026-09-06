/* Log browser — lists recorded flight sessions and scrubs through one.
   Sessions come from, in order of preference: the `sessions` / `onLoad`
   props, the Electron recorder bridge (window.eis.recorder), or the
   in-memory recorder singleton. Whatever the source, a session is folded
   into the recorder's RecordingSession shape before the timeline reads it —
   the shell's NDJSON sessions carry raw telemetry/tracking messages and a
   `{ meta, frames }` envelope, the in-memory recorder carries frames. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderClock, Play, Radio, SkipBack, SkipForward, Trash2 } from 'lucide-react';
import { Modal, Button, IconButton, StatusPill, Badge } from '@/components';
import type { StatusPillStatus } from '@/components/StatusPill';
import { recorder, toRecordedFrame } from '@/store/recorder';
import type { RecordedFrame, RecordingMeta, RecordingSession } from '@/store/recorder';
import type { TrackingState } from '@/contract';

export interface LogBrowserModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional pre-loaded session list; if omitted the bridge or recorder.list() is queried. */
  sessions?: RecordingMeta[];
  /** Optional async loader; if omitted the bridge or recorder.load() is used. */
  onLoad?: (id: string) => Promise<{ meta: RecordingMeta; frames: RecordedFrame[] }>;
}

/* ---- pure helpers ---------------------------------------------------------- */

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null;
}

function firstNumber(...candidates: unknown[]): number | undefined {
  for (const c of candidates) if (typeof c === 'number' && Number.isFinite(c)) return c;
  return undefined;
}

function firstString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) if (typeof c === 'string' && c !== '') return c;
  return undefined;
}

/**
 * Fold any session-like value into a RecordingSession. Accepts the in-memory
 * recorder's sessions, the bridge's `{ meta, frames }` envelope (id and
 * startedAt live inside `meta`, frames are raw wire messages) and the
 * `onLoad` prop's `{ ...meta, frames }`. `hint` is the list entry the
 * operator clicked — the fallback for anything the payload lacks.
 */
export function normaliseSession(raw: unknown, hint?: Partial<RecordingMeta>): RecordingSession | null {
  const d = asDict(raw);
  if (!d) return null;
  const meta = asDict(d.meta) ?? {};
  const id = firstString(d.id, meta.id, hint?.id);
  if (!id) return null;

  const frames = (Array.isArray(d.frames) ? d.frames : [])
    .map(toRecordedFrame)
    .filter((f): f is RecordedFrame => f !== null)
    .sort((a, b) => a.ts - b.ts);

  const startedAt = firstNumber(d.startedAt, meta.startedAt, hint?.startedAt, frames[0]?.ts) ?? 0;
  const lastTs = frames.length ? frames[frames.length - 1].ts : startedAt;
  const durationMs = Math.max(firstNumber(d.durationMs, hint?.durationMs) ?? 0, lastTs - startedAt, 0);
  return { id, startedAt, durationMs, size: frames.length, meta, frames };
}

/** Index of the frame whose timestamp is nearest `ts` (frames ascending; -1 when empty). */
export function nearestFrameIndex(frames: readonly { ts: number }[], ts: number): number {
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].ts < ts) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first frame at or after ts; the one before may be closer.
  if (lo > 0 && Math.abs(frames[lo - 1].ts - ts) <= Math.abs(frames[lo].ts - ts)) return lo - 1;
  return lo;
}

function fmtClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

function fmtStamp(ts: number): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

/* ---- session sources ------------------------------------------------------- */

interface SessionRow extends RecordingMeta {
  sizeLabel: string;
}

interface SessionSource {
  list(): Promise<SessionRow[]>;
  load(id: string, hint?: RecordingMeta): Promise<RecordingSession | null>;
}

const withFrames = (m: RecordingMeta): SessionRow => ({ ...m, sizeLabel: `${m.size} frames` });
const withBytes = (m: RecordingMeta): SessionRow => ({
  ...m,
  sizeLabel: m.size >= 1024 ? `${(m.size / 1024).toFixed(1)} KB` : `${m.size} B`,
});

function toMeta(raw: unknown): RecordingMeta | null {
  const d = asDict(raw);
  const id = d ? firstString(d.id) : undefined;
  if (!d || !id) return null;
  return {
    id,
    startedAt: firstNumber(d.startedAt) ?? 0,
    durationMs: firstNumber(d.durationMs) ?? 0,
    size: firstNumber(d.size) ?? 0,
  };
}

function resolveSource(sessionsProp?: RecordingMeta[], onLoadProp?: LogBrowserModalProps['onLoad']): SessionSource {
  const bridge = typeof window !== 'undefined' ? window.eis?.recorder : undefined;

  const list = async (): Promise<SessionRow[]> => {
    if (sessionsProp) return sessionsProp.map(withFrames);
    if (bridge) {
      const entries = await bridge.list();
      return entries
        .map(toMeta)
        .filter((m): m is RecordingMeta => m !== null)
        .map(withBytes)
        .sort((a, b) => b.startedAt - a.startedAt);
    }
    return recorder.list().map(withFrames);
  };

  const load = async (id: string, hint?: RecordingMeta): Promise<RecordingSession | null> => {
    if (onLoadProp) {
      const result = await onLoadProp(id);
      return normaliseSession({ ...result.meta, frames: result.frames }, hint);
    }
    if (bridge) return normaliseSession(await bridge.load(id), { ...hint, id });
    return normaliseSession(recorder.load(id), hint);
  };

  return { list, load };
}

/* ---- presentation bits ----------------------------------------------------- */

const HEAD: React.CSSProperties = {
  fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
  textTransform: 'uppercase', color: 'var(--text-tertiary)',
};

const TRACK_STATUS: Record<TrackingState, StatusPillStatus> = {
  idle: 'neutral',
  searching: 'caution',
  locked: 'nominal',
  lost: 'danger',
};

function SessionRowView({ row, active, onSelect }: { row: SessionRow; active: boolean; onSelect: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        padding: '8px 9px', cursor: 'pointer',
        borderRadius: 'var(--radius-sm)',
        background: active ? 'var(--info-bg)' : 'var(--surface-input)',
        border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border-subtle)'}`,
        color: active ? 'var(--accent-text)' : 'var(--text-primary)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <Radio size={13} style={{ flex: 'none', color: active ? 'var(--accent-text)' : 'var(--text-tertiary)' }} />
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fmtStamp(row.startedAt)}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          {fmtClock(row.durationMs)} · {row.sizeLabel}
        </span>
      </span>
      <Play size={11} style={{ flex: 'none', color: 'var(--text-tertiary)' }} />
    </button>
  );
}

interface MiniMapProps {
  home: { lat: number; lon: number };
  current: { lat: number; lon: number };
  trail: { lat: number; lon: number }[];
}

/** Home-centred local map: equirectangular metres, auto-scaled to the trail. */
function MiniMap({ home, current, trail }: MiniMapProps): JSX.Element {
  const size = 112;
  const inset = 10;
  const metresPerDegLat = 110_540;
  const metresPerDegLon = 111_320 * Math.cos((home.lat * Math.PI) / 180);
  const local = (p: { lat: number; lon: number }) => ({
    x: (p.lon - home.lon) * metresPerDegLon,
    y: (p.lat - home.lat) * metresPerDegLat,
  });
  const points = [current, ...trail].map(local);
  const extent = Math.max(10, ...points.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y))));
  const scale = (size / 2 - inset) / extent;
  const toPx = (p: { x: number; y: number }) => ({ x: size / 2 + p.x * scale, y: size / 2 - p.y * scale });
  const here = toPx(points[0]);
  const path = trail.map(local).map(toPx).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Position relative to home"
      style={{
        flex: 'none',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <circle cx={size / 2} cy={size / 2} r={size / 2 - inset} fill="none" stroke="rgba(255,255,255,0.08)" strokeDasharray="2 3" />
      <line x1={size / 2 - 5} y1={size / 2} x2={size / 2 + 5} y2={size / 2} stroke="rgba(255,255,255,0.25)" />
      <line x1={size / 2} y1={size / 2 - 5} x2={size / 2} y2={size / 2 + 5} stroke="rgba(255,255,255,0.25)" />
      {path && <polyline points={path} fill="none" stroke="var(--accent)" strokeWidth={1.2} opacity={0.7} />}
      <circle cx={here.x} cy={here.y} r={4.5} fill="var(--amber)" />
      <text x={size - 4} y={size - 4} textAnchor="end" fontSize={8} fill="var(--text-tertiary)" fontFamily="var(--font-mono)">
        {Math.round(extent)} m
      </text>
    </svg>
  );
}

function Readout({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', background: 'var(--bg-sunken)', borderRadius: 'var(--radius-xs)' }}>
      <span style={{ ...HEAD, fontSize: 9 }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  );
}

/* ---- main component -------------------------------------------------------- */

export function LogBrowserModal({
  open,
  onClose,
  sessions: sessionsProp,
  onLoad: onLoadProp,
}: LogBrowserModalProps): JSX.Element | null {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [cursorMs, setCursorMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Every open starts from a fresh list and no selection.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSession(null);
    setCursorMs(0);
    setProblem(null);
    resolveSource(sessionsProp, onLoadProp)
      .list()
      .then((list) => { if (!cancelled) setRows(list); })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
        setProblem('The recordings list could not be read.');
      });
    return () => { cancelled = true; };
  }, [open, sessionsProp, onLoadProp]);

  const select = useCallback(async (row: SessionRow) => {
    setBusy(true);
    setProblem(null);
    try {
      const loaded = await resolveSource(sessionsProp, onLoadProp).load(row.id, row);
      if (loaded) {
        setSession(loaded);
        setCursorMs(0);
      } else {
        setProblem(`Session ${row.id} could not be loaded.`);
      }
    } catch (err) {
      setProblem((err as Error).message || 'The session failed to load.');
    } finally {
      setBusy(false);
    }
  }, [sessionsProp, onLoadProp]);

  const frameIndex = useMemo(
    () => (session ? nearestFrameIndex(session.frames, session.startedAt + cursorMs) : -1),
    [session, cursorMs],
  );
  const frame = session && frameIndex >= 0 ? session.frames[frameIndex] : null;

  const stepFrames = (delta: number): void => {
    if (!session || frameIndex < 0) return;
    const next = Math.min(session.frames.length - 1, Math.max(0, frameIndex + delta));
    setCursorMs(Math.max(0, session.frames[next].ts - session.startedAt));
  };

  // Breadcrumb up to the scrub position, thinned so long flights stay cheap.
  const trail = useMemo(() => {
    if (!session || frameIndex < 0) return [];
    const stride = Math.max(1, Math.ceil((frameIndex + 1) / 240));
    const points: { lat: number; lon: number }[] = [];
    for (let i = 0; i <= frameIndex; i += stride) {
      const t = session.frames[i].telemetry;
      if (t) points.push({ lat: t.position.lat, lon: t.position.lon });
    }
    return points;
  }, [session, frameIndex]);

  const clearAll = (): void => {
    recorder.clear();
    setRows([]);
    setSession(null);
    setCursorMs(0);
  };

  const tel = frame?.telemetry ?? null;
  const trk = frame?.tracking ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      icon={<FolderClock size={16} />}
      title="Log browser"
      subtitle="Select a recorded session, then scrub through the flight timeline."
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', gap: 14, padding: '4px 0 12px', minHeight: 250 }}>

        {/* Sessions */}
        <aside style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={HEAD}>Recorded sessions</span>
            <Badge tone="neutral" mono>{rows.length}</Badge>
          </div>
          {rows.length === 0 ? (
            <div style={{
              padding: '20px 8px', textAlign: 'center',
              fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.45,
              background: 'var(--surface-input)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
            }}>
              No sessions recorded yet. Start a flight to begin recording.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' }}>
              {rows.map((row) => (
                <SessionRowView key={row.id} row={row} active={session?.id === row.id} onSelect={() => { void select(row); }} />
              ))}
            </div>
          )}
          {rows.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={11} />}
              onClick={clearAll}
              style={{ alignSelf: 'flex-start', marginTop: 'auto' }}
            >
              Clear all sessions
            </Button>
          )}
        </aside>

        {/* Player */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {!session && (
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center', padding: 16,
              border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-sm)',
            }}>
              {busy ? 'Loading…' : 'Select a session to scrub its timeline.'}
            </div>
          )}

          {session && (
            <>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={HEAD}>Timeline</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
                    {fmtClock(cursorMs)} / {fmtClock(session.durationMs)}
                    {frameIndex >= 0 && ` · frame ${frameIndex + 1}/${session.frames.length}`}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <IconButton size="sm" title="Previous frame" icon={<SkipBack size={12} />} disabled={frameIndex <= 0} onClick={() => stepFrames(-1)} />
                  <input
                    type="range"
                    aria-label="Timeline"
                    min={0}
                    max={Math.max(1, session.durationMs)}
                    step={100}
                    value={cursorMs}
                    onChange={(e) => setCursorMs(Number(e.target.value))}
                    style={{ flex: 1, accentColor: 'var(--accent)' }}
                  />
                  <IconButton size="sm" title="Next frame" icon={<SkipForward size={12} />} disabled={frameIndex < 0 || frameIndex >= session.frames.length - 1} onClick={() => stepFrames(1)} />
                </div>
              </div>

              {busy && <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>Loading…</div>}

              {!busy && !frame && (
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>This session holds no telemetry or tracking frames.</div>
              )}

              {!busy && frame && (
                <div style={{
                  display: 'flex', gap: 12, alignItems: 'flex-start', padding: 12,
                  background: 'var(--surface-input)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-subtle)',
                }}>
                  {tel && (
                    <MiniMap
                      home={{ lat: tel.home.lat, lon: tel.home.lon }}
                      current={{ lat: tel.position.lat, lon: tel.position.lon }}
                      trail={trail}
                    />
                  )}
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {tel && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                        <Readout label="Alt" value={`${tel.position.relAlt.toFixed(1)} m`} />
                        <Readout label="Spd" value={`${tel.velocity.groundspeed.toFixed(1)} m/s`} />
                        <Readout label="Bat" value={`${Math.round(tel.battery.remaining)}%`} />
                        <Readout label="Hdg" value={`${Math.round(tel.heading)}°`} />
                        <Readout label="Sats" value={String(tel.gps.satellites)} />
                        <Readout label="Mode" value={tel.mode} />
                      </div>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      {tel && (
                        <StatusPill status={tel.armed ? 'nominal' : 'neutral'} size="sm">
                          {tel.armed ? 'Armed' : 'Disarmed'}
                        </StatusPill>
                      )}
                      {trk && (
                        <>
                          <StatusPill status={TRACK_STATUS[trk.state]} size="sm">{trk.state}</StatusPill>
                          {trk.state === 'locked' && trk.estimatedDistance != null && (
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
                              {trk.estimatedDistance.toFixed(1)} m
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {problem && (
            <div role="alert" style={{ fontSize: 11, color: 'var(--red-bright)' }}>{problem}</div>
          )}
        </section>
      </div>
    </Modal>
  );
}
