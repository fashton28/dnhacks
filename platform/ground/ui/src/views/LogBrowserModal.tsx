/* Log browser modal — lists recorded flight sessions and lets the operator
   scrub through them, previewing telemetry readouts + a small position dot
   + tracking state at the scrubbed time.
   Props: { open; onClose; sessions?; onLoad?(id): Promise<{meta, frames}> }
   Falls back to window.eis?.recorder.list() when present, else the in-memory
   recorder singleton.                                                          */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { FolderClock, Play, Trash2, Radio } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/Button';
import { recorder } from '@/store/recorder';
import type { RecordingMeta, RecordedFrame, RecordingSession } from '@/store/recorder';
import type { TrackingState } from '@/contract';

export interface LogBrowserModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional pre-loaded session list; if omitted the component queries recorder.list(). */
  sessions?: RecordingMeta[];
  /** Optional async loader; if omitted falls back to recorder.load(). */
  onLoad?: (id: string) => Promise<{ meta: RecordingMeta; frames: RecordedFrame[] }>;
}

/* ---- helpers --------------------------------------------------------------- */

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* Lookup the frame closest to a given elapsed-ms position within a session. */
function frameAt(frames: RecordedFrame[], startedAt: number, elapsedMs: number): RecordedFrame | null {
  if (!frames.length) return null;
  const target = startedAt + elapsedMs;
  let closest = frames[0];
  let closestDist = Math.abs(closest.ts - target);
  for (let i = 1; i < frames.length; i++) {
    const d = Math.abs(frames[i].ts - target);
    if (d < closestDist) { closestDist = d; closest = frames[i]; }
    if (d > closestDist) break; // frames are chronological; stop early
  }
  return closest;
}

/* ---- tracking state pill --------------------------------------------------- */

const TRACK_LABELS: Record<TrackingState, string> = {
  idle: 'Idle',
  searching: 'Searching',
  locked: 'Locked',
  lost: 'Lost',
};
const TRACK_COLORS: Record<TrackingState, { fg: string; bg: string; border: string }> = {
  idle:      { fg: 'var(--text-tertiary)', bg: 'var(--surface-input)', border: 'var(--border-subtle)' },
  searching: { fg: 'var(--amber-bright)',  bg: 'var(--caution-bg)',    border: 'var(--amber-line)'   },
  locked:    { fg: 'var(--green-bright)',  bg: 'var(--nominal-bg)',    border: 'var(--green-line)'   },
  lost:      { fg: 'var(--red-bright)',    bg: 'var(--danger-bg)',     border: 'var(--red-line)'     },
};

function TrackPill({ state }: { state: TrackingState }): JSX.Element {
  const c = TRACK_COLORS[state];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px', borderRadius: 'var(--radius-pill)',
      background: c.bg, border: `1px solid ${c.border}`,
      fontSize: 11, fontWeight: 600, color: c.fg,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: c.fg, flex: 'none' }} />
      {TRACK_LABELS[state]}
    </span>
  );
}

/* ---- mini position map ----------------------------------------------------- */

function MiniMap({ lat, lon, homeLat, homeLon }: {
  lat: number; lon: number; homeLat: number; homeLon: number;
}): JSX.Element {
  // Project a tiny area around home into the 100×100 canvas.
  const size = 100;
  const scale = 2000; // px per degree (roughly)
  const cx = size / 2 + (lon - homeLon) * scale;
  const cy = size / 2 - (lat - homeLat) * scale;
  const hx = size / 2;
  const hy = size / 2;

  return (
    <svg
      width={size} height={size}
      style={{
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border-subtle)',
        flex: 'none',
      }}
      viewBox={`0 0 ${size} ${size}`}
    >
      {/* home marker */}
      <circle cx={hx} cy={hy} r={4} fill="var(--text-tertiary)" opacity={0.5} />
      {/* drone position */}
      <circle cx={Math.max(4, Math.min(size - 4, cx))} cy={Math.max(4, Math.min(size - 4, cy))} r={5} fill="var(--amber)" />
      {/* crosshair tick */}
      <line x1={hx - 6} y1={hy} x2={hx + 6} y2={hy} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
      <line x1={hx} y1={hy - 6} x2={hx} y2={hy + 6} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
    </svg>
  );
}

/* ---- session row ----------------------------------------------------------- */

interface SessionRowProps {
  meta: RecordingMeta;
  active: boolean;
  onLoad: () => void;
}

function SessionRow({ meta, active, onLoad }: SessionRowProps): JSX.Element {
  return (
    <div
      onClick={onLoad}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 10px',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        background: active ? 'var(--info-bg)' : 'var(--surface-input)',
        border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border-subtle)'}`,
        transition: 'all var(--dur-fast)',
      }}
    >
      <Radio size={14} style={{ color: active ? 'var(--accent-text)' : 'var(--text-tertiary)', flex: 'none' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: active ? 'var(--accent-text)' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fmtDate(meta.startedAt)}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', marginTop: 1 }}>
          {fmtDuration(meta.durationMs)} · {meta.size} frames
        </div>
      </div>
      <Play size={12} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
    </div>
  );
}

/* ---- main component -------------------------------------------------------- */

export function LogBrowserModal({ open, onClose, sessions: sessionsProp, onLoad: onLoadProp }: LogBrowserModalProps): JSX.Element | null {
  const [sessions, setSessions] = useState<RecordingMeta[]>([]);
  const [loadedSession, setLoadedSession] = useState<RecordingSession | null>(null);
  const [scrubMs, setScrubMs] = useState(0);
  const [loading, setLoading] = useState(false);

  // Refresh session list when modal opens
  useEffect(() => {
    if (!open) return;
    if (sessionsProp) {
      setSessions(sessionsProp);
    } else {
      // Try the Electron bridge (async) first, else the in-memory recorder (sync).
      const bridge = window.eis?.recorder;
      Promise.resolve(bridge ? bridge.list() : recorder.list())
        .then((list) => setSessions(list as RecordingMeta[]))
        .catch(() => setSessions([]));
    }
    setLoadedSession(null);
    setScrubMs(0);
  }, [open, sessionsProp]);

  const handleLoad = useCallback(async (id: string) => {
    setLoading(true);
    try {
      let session: RecordingSession | null = null;
      if (onLoadProp) {
        const result = await onLoadProp(id);
        session = { ...result.meta, frames: result.frames, meta: {} };
      } else {
        // Electron bridge load() is async; the in-memory recorder load() is sync.
        const bridge = window.eis?.recorder;
        const loaded = await Promise.resolve(bridge ? bridge.load(id) : recorder.load(id));
        session = (loaded as RecordingSession | null) ?? null;
      }
      if (session) {
        setLoadedSession(session);
        setScrubMs(0);
      }
    } finally {
      setLoading(false);
    }
  }, [onLoadProp]);

  const currentFrame = useMemo(() => {
    if (!loadedSession) return null;
    return frameAt(loadedSession.frames, loadedSession.startedAt, scrubMs);
  }, [loadedSession, scrubMs]);

  const tel = currentFrame?.telemetry ?? null;
  const trk = currentFrame?.tracking ?? null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      icon={<FolderClock size={16} />}
      title="Log browser"
      subtitle="Select a recorded session, then scrub through the flight timeline."
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 0 12px' }}>

        {/* Session list */}
        <div>
          <div style={{
            fontSize: 10, fontWeight: 600,
            letterSpacing: '0.06em', textTransform: 'uppercase',
            color: 'var(--text-tertiary)', marginBottom: 6,
          }}>
            Recorded sessions
          </div>
          {sessions.length === 0 ? (
            <div style={{
              padding: '20px 0', textAlign: 'center',
              fontSize: 12, color: 'var(--text-tertiary)',
              background: 'var(--surface-input)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
            }}>
              No sessions recorded yet. Start a flight to begin recording.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 180, overflow: 'auto' }}>
              {sessions.map(s => (
                <SessionRow
                  key={s.id}
                  meta={s}
                  active={loadedSession?.id === s.id}
                  onLoad={() => { void handleLoad(s.id); }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Timeline scrubber + preview — only shown once a session is loaded */}
        {loadedSession && (
          <>
            {/* Scrubber */}
            <div>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginBottom: 6,
              }}>
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: 'var(--text-tertiary)',
                }}>
                  Timeline
                </span>
                <span style={{
                  fontFamily: 'var(--font-mono)', fontSize: 11,
                  color: 'var(--text-secondary)',
                }}>
                  {fmtDuration(scrubMs)} / {fmtDuration(loadedSession.durationMs)}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={loadedSession.durationMs || 1}
                step={100}
                value={scrubMs}
                onChange={e => setScrubMs(Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--accent)' }}
              />
            </div>

            {/* Telemetry preview */}
            {loading && (
              <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
                Loading…
              </div>
            )}

            {!loading && currentFrame && (
              <div style={{
                display: 'flex', gap: 12, alignItems: 'flex-start',
                padding: '12px',
                background: 'var(--surface-input)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
              }}>
                {/* Mini map */}
                {tel && (
                  <MiniMap
                    lat={tel.position.lat}
                    lon={tel.position.lon}
                    homeLat={tel.home.lat}
                    homeLon={tel.home.lon}
                  />
                )}

                {/* Readouts */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {tel && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                      {[
                        { label: 'Alt', value: `${tel.position.relAlt.toFixed(1)} m` },
                        { label: 'Spd', value: `${tel.velocity.groundspeed.toFixed(1)} m/s` },
                        { label: 'Bat', value: `${Math.round(tel.battery.remaining)}%` },
                        { label: 'Hdg', value: `${Math.round(tel.heading)}°` },
                        { label: 'Sats', value: String(tel.gps.satellites) },
                        { label: 'Mode', value: tel.mode },
                      ].map(({ label, value }) => (
                        <div key={label} style={{
                          display: 'flex', flexDirection: 'column', gap: 2,
                          padding: '6px 8px',
                          background: 'var(--bg-sunken)',
                          borderRadius: 'var(--radius-xs)',
                        }}>
                          <span style={{
                            fontSize: 9, fontWeight: 600,
                            letterSpacing: '0.06em', textTransform: 'uppercase',
                            color: 'var(--text-tertiary)',
                          }}>
                            {label}
                          </span>
                          <span style={{
                            fontFamily: 'var(--font-mono)', fontSize: 13,
                            color: 'var(--text-primary)',
                            fontVariantNumeric: 'tabular-nums',
                          }}>
                            {value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tracking state */}
                  {trk && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Tracking</span>
                      <TrackPill state={trk.state} />
                      {trk.state === 'locked' && trk.estimatedDistance != null && (
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
                          {trk.estimatedDistance.toFixed(1)} m
                        </span>
                      )}
                    </div>
                  )}

                  {/* Armed / mode indicators */}
                  {tel && (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '2px 8px', borderRadius: 'var(--radius-pill)',
                        background: tel.armed ? 'var(--nominal-bg)' : 'var(--surface-input)',
                        border: `1px solid ${tel.armed ? 'var(--green-line)' : 'var(--border-subtle)'}`,
                        fontSize: 11, fontWeight: 600,
                        color: tel.armed ? 'var(--green-bright)' : 'var(--text-tertiary)',
                      }}>
                        {tel.armed ? 'ARMED' : 'DISARMED'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Delete session */}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  recorder.clear();
                  setSessions([]);
                  setLoadedSession(null);
                  setScrubMs(0);
                }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  height: 28, padding: '0 10px',
                  background: 'transparent',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-tertiary)', fontSize: 11, cursor: 'pointer',
                }}
              >
                <Trash2 size={11} />
                Clear all sessions
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
