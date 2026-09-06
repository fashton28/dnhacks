/* VideoPanel — the forward view plus the tracking overlay.
 *
 * The picture source is decided from `videoUrl` alone (see videoSourceKind):
 *   ''                              → synthetic canvas scene (the mock provider)
 *   …mjpeg…                         → <img> (multipart/x-mixed-replace, the ARGUS Hub)
 *   http(s):// webrtc:// whep://    → <video> fed by a minimal WHEP client
 *   rtsp://                         → black area with a note (browsers cannot play RTSP)
 * Whatever the source, the SAME overlay goes on top: clickable target boxes,
 * a crosshair, the range HUD while locked, and the tracking-state chip.
 */
import React from 'react';
import { Badge } from '@/components';
import { VIDEO } from '@/theme/tokens';
import type { ConnectionState, DetectedTarget, TrackingState, TrackingStatus } from '@/contract';

interface VideoPanelProps {
  tracking: TrackingStatus | null;
  connState: ConnectionState;
  standoff: number;
  onSelectTarget: (id: number) => void;
  videoUrl?: string;
}

/* ------------------------------------------------------------------ */
/*  Source selection — pure, exported for tests                         */
/* ------------------------------------------------------------------ */

export type VideoSourceKind = 'mock' | 'mjpeg' | 'live' | 'rtsp';

/** Classify a configured video URL. MJPEG wins over the scheme because the
 *  Hub serves it over plain http; an unknown or empty URL falls back to the
 *  synthetic scene rather than a black box. */
export function videoSourceKind(url: string | undefined): VideoSourceKind {
  const trimmed = (url ?? '').trim();
  if (!trimmed) return 'mock';
  if (/mjpeg/i.test(trimmed)) return 'mjpeg';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  switch (scheme) {
    case 'http':
    case 'https':
    case 'webrtc':
    case 'whep':
      return 'live';
    case 'rtsp':
      return 'rtsp';
    default:
      return 'mock';
  }
}

/** WHEP endpoint for a live URL: the webrtc:// and whep:// spellings mean https://. */
export function whepEndpoint(url: string): string {
  return url.replace(/^(?:webrtc|whep):/i, 'https:');
}

/** Chip label, chip colour and frame colour per tracking state. */
export const TRACK_CHIP: Readonly<Record<TrackingState, { label: string; color: string; border: string }>> = {
  idle:      { label: 'Tracking Idle',     color: 'var(--text-tertiary)', border: 'transparent' },
  searching: { label: 'Searching',         color: 'var(--accent-text)',   border: 'var(--accent)' },
  locked:    { label: 'Tracking · Locked', color: 'var(--amber-bright)',  border: 'var(--amber)' },
  lost:      { label: 'Target Lost',       color: 'var(--red-bright)',    border: 'var(--red)' },
};

/** Box caption: "LOCKED · 87%" for the locked target, "PERSON 3 · 62%" otherwise. */
export function targetCaption(t: Pick<DetectedTarget, 'id' | 'confidence' | 'isLocked'>): string {
  const pct = Math.round(t.confidence * 100);
  return `${t.isLocked ? 'LOCKED' : `PERSON ${t.id}`} · ${pct}%`;
}

/* ------------------------------------------------------------------ */
/*  Synthetic scene                                                     */
/* ------------------------------------------------------------------ */

const HORIZON = 0.42;

function capsule(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = Math.min(w, h) / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  ctx.lineTo(x + r, y + h);
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + r);
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

function paintFigure(ctx: CanvasRenderingContext2D, t: DetectedTarget, w: number, h: number): void {
  const [nx, ny, nw, nh] = t.bbox;
  const x = nx * w;
  const y = ny * h;
  const bw = nw * w;
  const bh = nh * h;

  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(x + bw / 2, y + bh, bw * 0.5, bh * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = t.isLocked ? VIDEO.bodyLocked : VIDEO.body;
  capsule(ctx, x + bw * 0.22, y + bh * 0.28, bw * 0.56, bh * 0.72);
  ctx.fill();

  ctx.fillStyle = VIDEO.head;
  ctx.beginPath();
  ctx.arc(x + bw / 2, y + bh * 0.16, bw * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

/** Paint one frame of the mock forward view into a `w`×`h` CSS-pixel context.
 *  Figures stand at the tracker's normalised bbox positions so the DOM boxes
 *  drawn over them line up. */
export function paintMockScene(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  targets: readonly DetectedTarget[],
): void {
  const horizon = h * HORIZON;

  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, VIDEO.skyTop);
  sky.addColorStop(1, VIDEO.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon);

  const ground = ctx.createLinearGradient(0, horizon, 0, h);
  ground.addColorStop(0, VIDEO.groundTop);
  ground.addColorStop(1, VIDEO.groundBottom);
  ctx.fillStyle = ground;
  ctx.fillRect(0, horizon, w, h - horizon);

  // One batched path for the perspective lattice: rays fanning out of the
  // vanishing point, plus rows that bunch up toward the horizon.
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = -6; k <= 6; k++) {
    ctx.moveTo(w / 2, horizon);
    ctx.lineTo(w / 2 + k * w * 0.16, h);
  }
  for (let row = 1; row <= 5; row++) {
    const y = horizon + (h - horizon) * (row / 5) ** 2;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.restore();

  for (const t of targets) paintFigure(ctx, t, w, h);
}

function MockScene({ targets, visible }: { targets: readonly DetectedTarget[]; visible: boolean }) {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const targetsRef = React.useRef(targets);
  targetsRef.current = targets;

  React.useEffect(() => {
    if (!visible) return;
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!host || !canvas || !ctx) return;

    let size = { w: host.clientWidth || 800, h: host.clientHeight || 450 };
    const fit = (): void => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(size.w * dpr));
      canvas.height = Math.max(1, Math.round(size.h * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        size = { w: rect.width, h: rect.height };
        fit();
      }
    });
    observer.observe(host);
    fit();

    let raf = 0;
    const paint = (): void => {
      paintMockScene(ctx, size.w, size.h, targetsRef.current);
      raf = window.requestAnimationFrame(paint);
    };
    raf = window.requestAnimationFrame(paint);
    return () => {
      window.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [visible]);

  return (
    <div ref={hostRef} style={{ position: 'absolute', inset: 0, display: visible ? 'block' : 'none' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Live sources                                                        */
/* ------------------------------------------------------------------ */

const MEDIA_FILL: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  background: '#000',
  display: 'block',
};

/** Minimal WHEP client: offer → POST → answer, inbound tracks onto the
 *  element. Returns the teardown. Aborting cancels the in-flight POST and
 *  suppresses the failure callback. */
function openWhepSession(endpoint: string, video: HTMLVideoElement, onFail: () => void): () => void {
  const abort = new AbortController();
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const inbound = new MediaStream();
  video.srcObject = inbound;

  for (const kind of ['video', 'audio'] as const) pc.addTransceiver(kind, { direction: 'recvonly' });
  pc.addEventListener('track', (ev: RTCTrackEvent) => {
    for (const track of ev.streams[0]?.getTracks() ?? [ev.track]) inbound.addTrack(track);
  });

  // Resolve once ICE gathering completes, or after 1.5 s with whatever we have.
  const gathered = (): Promise<void> =>
    new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = (): void => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, 1500);
      pc.addEventListener('icegatheringstatechange', check);
    });

  (async () => {
    await pc.setLocalDescription(await pc.createOffer());
    await gathered();
    const sdp = pc.localDescription?.sdp;
    if (!sdp || abort.signal.aborted) return;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdp,
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`WHEP ${res.status}`);
    const answer = await res.text();
    if (abort.signal.aborted) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  })().catch(() => {
    if (!abort.signal.aborted) onFail();
  });

  return () => {
    abort.abort();
    try {
      pc.close();
    } catch {
      /* already closed */
    }
    video.srcObject = null;
  };
}

function WhepVideo({ endpoint }: { endpoint: string }) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setFailed(false);
    return openWhepSession(endpoint, video, () => setFailed(true));
  }, [endpoint]);

  return (
    <>
      <video ref={videoRef} autoPlay muted playsInline style={MEDIA_FILL} />
      {failed && <FloatingNote danger>STREAM UNAVAILABLE</FloatingNote>}
    </>
  );
}

function RtspNotice() {
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 340 }}>
        RTSP source — view via WebRTC bridge (see docs/network.md)
      </span>
    </div>
  );
}

function NoSignal({ connecting }: { connecting: boolean }) {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-disabled)' }}>
      <svg width="46" height="46" viewBox="0 0 46 46" aria-hidden>
        <circle cx="23" cy="23" r="22" fill="none" stroke="var(--gray-6)" strokeWidth="2" />
        <path d="M15 31 L31 15" stroke="var(--gray-6)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, letterSpacing: '0.1em' }}>
        {connecting ? 'CONNECTING…' : 'NO VIDEO SIGNAL'}
      </span>
    </div>
  );
}

/** Small pill floated at the top centre of the picture. */
function FloatingNote({ children, danger = false }: { children: React.ReactNode; danger?: boolean }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '4px 9px',
        background: 'rgba(8,12,16,0.8)',
        backdropFilter: 'blur(6px)',
        border: `1px solid ${danger ? 'var(--red-line)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-pill)',
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        fontWeight: 600,
        color: danger ? 'var(--red-bright)' : 'var(--text-secondary)',
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tracking overlay                                                    */
/* ------------------------------------------------------------------ */

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
type Corner = (typeof CORNERS)[number];

function cornerStyle(c: Corner): React.CSSProperties {
  const edge = '2px solid var(--amber-bright)';
  const top = c[0] === 't';
  const left = c[1] === 'l';
  return {
    position: 'absolute',
    width: 7,
    height: 7,
    top: top ? -1 : undefined,
    bottom: top ? undefined : -1,
    left: left ? -1 : undefined,
    right: left ? undefined : -1,
    borderTop: top ? edge : undefined,
    borderBottom: top ? undefined : edge,
    borderLeft: left ? edge : undefined,
    borderRight: left ? undefined : edge,
  };
}

function TargetBox({ target, onSelect }: { target: DetectedTarget; onSelect: (id: number) => void }) {
  const [nx, ny, nw, nh] = target.bbox;
  const locked = target.isLocked;
  const caption = targetCaption(target);
  return (
    <button
      type="button"
      onClick={() => onSelect(target.id)}
      title={`Select target #${target.id}`}
      aria-label={caption}
      style={{
        position: 'absolute',
        left: `${nx * 100}%`,
        top: `${ny * 100}%`,
        width: `${nw * 100}%`,
        height: `${nh * 100}%`,
        padding: 0,
        background: 'transparent',
        cursor: 'pointer',
        borderRadius: 2,
        border: `1.5px solid ${locked ? 'var(--amber-bright)' : 'rgba(255,255,255,0.6)'}`,
        boxShadow: locked ? '0 0 0 1px rgba(0,0,0,0.5), 0 0 14px rgba(245,166,35,0.4)' : 'none',
        transition: 'border-color var(--dur-fast)',
      }}
    >
      {locked && CORNERS.map((c) => <span key={c} style={cornerStyle(c)} />)}
      <span
        style={{
          position: 'absolute',
          top: -18,
          left: -1.5,
          height: 16,
          display: 'inline-flex',
          alignItems: 'center',
          padding: '1px 5px',
          borderRadius: 2,
          whiteSpace: 'nowrap',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: 600,
          background: locked ? 'var(--amber)' : 'rgba(0,0,0,0.7)',
          color: locked ? '#1a1205' : '#fff',
        }}
      >
        {caption}
      </span>
    </button>
  );
}

function Crosshair() {
  return (
    <svg
      width="44"
      height="44"
      viewBox="0 0 44 44"
      aria-hidden
      style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', pointerEvents: 'none', opacity: 0.55 }}
    >
      <g fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="1.4" strokeLinecap="round">
        {[0, 90, 180, 270].map((deg) => (
          <path key={deg} d="M22 6 V16" transform={`rotate(${deg} 22 22)`} />
        ))}
      </g>
      <circle cx="22" cy="22" r="2" fill="rgba(255,255,255,0.8)" />
    </svg>
  );
}

function HudValue({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 500, color }}>
        {value}
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}> {unit}</span>
      </span>
    </div>
  );
}

function RangeHud({ distance, standoff }: { distance: number; standoff: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 14,
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '7px 14px',
        background: 'rgba(8,12,16,0.78)',
        backdropFilter: 'blur(6px)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        fontFamily: 'var(--font-mono)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <HudValue label="DIST" value={distance.toFixed(1)} unit="m" color="var(--amber-bright)" />
      <div style={{ width: 1, height: 22, background: 'var(--border-default)' }} />
      <HudValue label="STANDOFF" value={standoff.toFixed(1)} unit="m" color="var(--text-secondary)" />
    </div>
  );
}

function StateChip({ state }: { state: TrackingState }) {
  const chip = TRACK_CHIP[state];
  return (
    <span
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        background: 'rgba(8,12,16,0.7)',
        backdropFilter: 'blur(6px)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-pill)',
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: chip.color,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: chip.color }} />
      {chip.label}
    </span>
  );
}

function TrackingOverlay({
  tracking,
  standoff,
  onSelectTarget,
}: {
  tracking: TrackingStatus | null;
  standoff: number;
  onSelectTarget: (id: number) => void;
}) {
  const state: TrackingState = tracking?.state ?? 'idle';
  const range = state === 'locked' ? (tracking?.estimatedDistance ?? null) : null;
  return (
    <>
      {state !== 'idle' && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            boxShadow: `inset 0 0 0 2px ${TRACK_CHIP[state].border}`,
            animation: state === 'locked' ? 'eis-trackpulse 1.3s ease-in-out infinite' : 'none',
          }}
        />
      )}
      {(tracking?.targets ?? []).map((t) => (
        <TargetBox key={t.id} target={t} onSelect={onSelectTarget} />
      ))}
      <Crosshair />
      {range != null && <RangeHud distance={range} standoff={standoff} />}
      <StateChip state={state} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

export function VideoPanel({ tracking, connState, standoff, onSelectTarget, videoUrl }: VideoPanelProps): React.ReactElement {
  const source = videoSourceKind(videoUrl);
  const url = (videoUrl ?? '').trim();
  const connected = connState === 'connected';

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: VIDEO.letterbox }}>
      {source === 'mock' && <MockScene targets={tracking?.targets ?? []} visible={connected} />}
      {source === 'mock' && !connected && <NoSignal connecting={connState === 'connecting'} />}
      {source === 'mjpeg' && <img src={url} alt="Drone view" style={MEDIA_FILL} />}
      {source === 'live' && <WhepVideo endpoint={whepEndpoint(url)} />}
      {source === 'rtsp' && <RtspNotice />}

      {connected && <TrackingOverlay tracking={tracking} standoff={standoff} onSelectTarget={onSelectTarget} />}

      <div style={{ position: 'absolute', top: 12, right: 12 }}>
        <Badge tone={connected ? 'danger' : 'neutral'}>● REC</Badge>
      </div>
    </div>
  );
}
