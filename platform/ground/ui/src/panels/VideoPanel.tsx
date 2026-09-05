/* VideoPanel — synthetic forward-view canvas scene + tracking overlay.
   Draws a believable scene with people at the mock's bbox positions, renders
   DOM bounding boxes for hover/click-to-select, crosshair, and distance HUD.

   When `videoUrl` is a non-empty http(s)/webrtc/whep URL a real <video> element
   replaces the mock canvas with the SAME tracking overlay drawn on top; a
   minimal WHEP client negotiates the stream. rtsp:// shows a note over a black
   area. Empty videoUrl falls back to the mock canvas. */
import React from 'react';
import { Badge } from '@/components';
import { VIDEO } from '@/theme/tokens';
import type { ConnectionState, TrackingStatus, TrackingState } from '@/contract';

interface VideoPanelProps {
  tracking: TrackingStatus | null;
  connState: ConnectionState;
  standoff: number;
  onSelectTarget: (id: number) => void;
  videoUrl?: string;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function trackColor(s: TrackingState | 'idle'): string {
  return s === 'locked'
    ? 'var(--amber-bright)'
    : s === 'searching'
      ? 'var(--accent-text)'
      : s === 'lost'
        ? 'var(--red-bright)'
        : 'var(--text-tertiary)';
}

function trackLabel(s: TrackingState | 'idle'): string {
  return s === 'locked'
    ? 'Tracking · Locked'
    : s === 'searching'
      ? 'Searching'
      : s === 'lost'
        ? 'Target Lost'
        : 'Tracking Idle';
}

interface HudValProps {
  label: string;
  value: string;
  unit: string;
  color: string;
}

function HudVal({ label, value, unit, color }: HudValProps): React.ReactElement {
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

/** True for live sources we can render in a <video> element via WHEP/WebRTC/HTTP. */
function isLiveUrl(url: string | undefined): url is string {
  if (!url) return false;
  return /^(https?|webrtc|whep):/i.test(url);
}

function isRtsp(url: string | undefined): url is string {
  return !!url && /^rtsp:/i.test(url);
}

/** Resolve a WHEP endpoint from the configured videoUrl. webrtc:// and whep://
 *  schemes are normalised to https://; an http(s) URL is used as-is (mediamtx
 *  serves WHEP at .../whep). */
function whepEndpoint(url: string): string {
  if (/^webrtc:/i.test(url)) return url.replace(/^webrtc:/i, 'https:');
  if (/^whep:/i.test(url)) return url.replace(/^whep:/i, 'https:');
  return url;
}

/** Minimal WHEP client: POST a local SDP offer, apply the SDP answer, and attach
 *  the inbound MediaStream to the <video> element. Returns a teardown fn. */
function startWhep(
  endpoint: string,
  video: HTMLVideoElement,
  onError: () => void,
): () => void {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  let cancelled = false;
  const stream = new MediaStream();
  video.srcObject = stream;

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (ev: RTCTrackEvent) => {
    ev.streams[0]?.getTracks().forEach((tr) => stream.addTrack(tr));
    if (!ev.streams[0]) stream.addTrack(ev.track);
  };

  const negotiate = async (): Promise<void> => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Wait for ICE gathering to complete so the offer carries candidates.
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const check = (): void => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, 1500);
    });
    if (cancelled || !pc.localDescription) return;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error(`WHEP ${res.status}`);
    const answer = await res.text();
    if (cancelled) return;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  };

  negotiate().catch(() => {
    if (!cancelled) onError();
  });

  return () => {
    cancelled = true;
    try {
      pc.close();
    } catch {
      /* ignore */
    }
    video.srcObject = null;
  };
}

export function VideoPanel({
  tracking,
  connState,
  standoff,
  onSelectTarget,
  videoUrl,
}: VideoPanelProps): React.ReactElement {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const trackRef = React.useRef<TrackingStatus | null>(tracking);
  trackRef.current = tracking;
  const sizeRef = React.useRef<{ w: number; h: number }>({ w: 800, h: 450 });

  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [whepFailed, setWhepFailed] = React.useState(false);

  const live = isLiveUrl(videoUrl);
  const rtsp = isRtsp(videoUrl);
  const useCanvas = !live && !rtsp;

  // resize observer (only needed for the mock canvas scene)
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // canvas scene animation (mock fallback only)
  React.useEffect(() => {
    if (!useCanvas) return;
    let raf = 0;
    let t = 0;
    const draw = (): void => {
      const cv = canvasRef.current;
      if (!cv) {
        raf = requestAnimationFrame(draw);
        return;
      }
      const { w, h } = sizeRef.current;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr;
        cv.height = h * dpr;
      }
      const ctx = cv.getContext('2d');
      if (!ctx) {
        raf = requestAnimationFrame(draw);
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      t += 0.016;
      const connected = connState === 'connected';

      // sky → ground gradient
      const horizon = h * 0.42;
      const g2 = ctx.createLinearGradient(0, 0, 0, horizon);
      g2.addColorStop(0, VIDEO.skyTop);
      g2.addColorStop(1, VIDEO.skyBottom);
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, w, horizon);
      // ground
      const grd = ctx.createLinearGradient(0, horizon, 0, h);
      grd.addColorStop(0, VIDEO.groundTop);
      grd.addColorStop(1, VIDEO.groundBottom);
      ctx.fillStyle = grd;
      ctx.fillRect(0, horizon, w, h - horizon);
      // perspective ground lines
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      for (let i = -6; i <= 6; i++) {
        ctx.beginPath();
        ctx.moveTo(w / 2, horizon);
        ctx.lineTo(w / 2 + i * w * 0.16, h);
        ctx.stroke();
      }
      for (let j = 1; j <= 5; j++) {
        const yy = horizon + (h - horizon) * (j / 5) * (j / 5);
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(w, yy);
        ctx.stroke();
      }

      // draw people from tracking targets
      if (connected) {
        const tk = trackRef.current;
        (tk?.targets ?? []).forEach((tgt) => {
          const [nx, ny, nw, nh] = tgt.bbox;
          const px = nx * w;
          const py = ny * h;
          const pw = nw * w;
          const ph = nh * h;
          // shadow
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath();
          ctx.ellipse(px + pw / 2, py + ph, pw * 0.5, ph * 0.08, 0, 0, Math.PI * 2);
          ctx.fill();
          // body
          ctx.fillStyle = tgt.isLocked ? VIDEO.bodyLocked : VIDEO.body;
          roundRect(ctx, px + pw * 0.22, py + ph * 0.28, pw * 0.56, ph * 0.72, pw * 0.18);
          ctx.fill();
          // head
          ctx.fillStyle = VIDEO.head;
          ctx.beginPath();
          ctx.arc(px + pw / 2, py + ph * 0.16, pw * 0.22, 0, Math.PI * 2);
          ctx.fill();
        });
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [connState, useCanvas]);

  // live WHEP negotiation
  React.useEffect(() => {
    if (!live) return;
    const vid = videoRef.current;
    if (!vid) return;
    setWhepFailed(false);
    const endpoint = whepEndpoint(videoUrl);
    const teardown = startWhep(endpoint, vid, () => setWhepFailed(true));
    return teardown;
  }, [live, videoUrl]);

  const connected = connState === 'connected';
  const state: TrackingState | 'idle' = tracking?.state ?? 'idle';

  // border treatment per tracking state
  const borderColor = !connected
    ? 'transparent'
    : state === 'locked'
      ? 'var(--amber)'
      : state === 'searching'
        ? 'var(--accent)'
        : state === 'lost'
          ? 'var(--red)'
          : 'transparent';

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: VIDEO.letterbox }}>
      {/* mock canvas scene */}
      {useCanvas && (
        <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: connected ? 'block' : 'none' }} />
      )}

      {/* live video element */}
      {live && (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000', display: 'block' }}
        />
      )}

      {/* rtsp note over a black area (overlay still drawn) */}
      {rtsp && (
        <div style={{ position: 'absolute', inset: 0, background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 340 }}>
            RTSP source — view via WebRTC bridge (see docs/network.md)
          </span>
        </div>
      )}

      {/* WHEP negotiation failure note */}
      {live && whepFailed && (
        <div style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', padding: '4px 9px', background: 'rgba(8,12,16,0.8)', backdropFilter: 'blur(6px)', border: '1px solid var(--red-line)', borderRadius: 'var(--radius-pill)', fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, color: 'var(--red-bright)' }}>
          STREAM UNAVAILABLE
        </div>
      )}

      {/* active-tracking pulsing border */}
      {connected && (state === 'locked' || state === 'searching' || state === 'lost') && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            boxShadow: `inset 0 0 0 2px ${borderColor}`,
            animation: state === 'locked' ? 'eis-trackpulse 1.3s ease-in-out infinite' : 'none',
          }}
        />
      )}

      {/* no-signal / disconnected (mock canvas only) */}
      {useCanvas && !connected && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--text-disabled)' }}>
          <div style={{ width: 46, height: 46, borderRadius: '50%', border: '2px solid var(--gray-6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 22, height: 2, background: 'var(--gray-6)', transform: 'rotate(45deg)' }} />
          </div>
          <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, letterSpacing: '0.1em' }}>
            {connState === 'connecting' ? 'CONNECTING…' : 'NO VIDEO SIGNAL'}
          </span>
        </div>
      )}

      {/* bounding boxes (DOM, clickable) */}
      {connected &&
        (tracking?.targets ?? []).map((tgt) => {
          const [nx, ny, nw, nh] = tgt.bbox;
          const locked = tgt.isLocked;
          return (
            <button
              key={tgt.id}
              onClick={() => onSelectTarget(tgt.id)}
              title={`Select target #${tgt.id}`}
              style={{
                position: 'absolute',
                left: `${nx * 100}%`,
                top: `${ny * 100}%`,
                width: `${nw * 100}%`,
                height: `${nh * 100}%`,
                border: `1.5px solid ${locked ? 'var(--amber-bright)' : 'rgba(255,255,255,0.6)'}`,
                borderRadius: 2,
                background: 'transparent',
                cursor: 'pointer',
                padding: 0,
                boxShadow: locked ? '0 0 0 1px rgba(0,0,0,0.5), 0 0 14px rgba(245,166,35,0.4)' : 'none',
                transition: 'border-color var(--dur-fast)',
              }}
            >
              {/* corner ticks */}
              {locked &&
                ([
                  ['0', '0'],
                  ['100%', '0'],
                  ['0', '100%'],
                  ['100%', '100%'],
                ] as const).map(([x, y], i) => (
                  <span
                    key={i}
                    style={{
                      position: 'absolute',
                      left: x,
                      top: y,
                      width: 7,
                      height: 7,
                      transform: `translate(${x === '0' ? '-1px' : '-6px'},${y === '0' ? '-1px' : '-6px'})`,
                      borderLeft: x === '0' ? '2px solid var(--amber-bright)' : 'none',
                      borderRight: x !== '0' ? '2px solid var(--amber-bright)' : 'none',
                      borderTop: y === '0' ? '2px solid var(--amber-bright)' : 'none',
                      borderBottom: y !== '0' ? '2px solid var(--amber-bright)' : 'none',
                    }}
                  />
                ))}
              <span
                style={{
                  position: 'absolute',
                  top: -18,
                  left: -1.5,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '1px 5px',
                  height: 16,
                  background: locked ? 'var(--amber)' : 'rgba(0,0,0,0.7)',
                  color: locked ? '#1a1205' : '#fff',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  fontWeight: 600,
                  borderRadius: 2,
                  whiteSpace: 'nowrap',
                }}
              >
                {locked ? 'LOCKED' : `PERSON ${tgt.id}`} · {Math.round(tgt.confidence * 100)}%
              </span>
            </button>
          );
        })}

      {/* center crosshair */}
      {connected && (
        <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', pointerEvents: 'none', opacity: 0.55 }}>
          <svg width="44" height="44" viewBox="0 0 44 44" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="1.4">
            <path d="M22 6 V16 M22 28 V38 M6 22 H16 M28 22 H38" strokeLinecap="round" />
            <circle cx="22" cy="22" r="2" fill="rgba(255,255,255,0.8)" stroke="none" />
          </svg>
        </div>
      )}

      {/* distance HUD */}
      {connected && state === 'locked' && tracking?.estimatedDistance != null && (
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
          <HudVal label="DIST" value={tracking.estimatedDistance.toFixed(1)} unit="m" color="var(--amber-bright)" />
          <div style={{ width: 1, height: 22, background: 'var(--border-default)' }} />
          <HudVal label="STANDOFF" value={standoff.toFixed(1)} unit="m" color="var(--text-secondary)" />
        </div>
      )}

      {/* top-left state chip */}
      {connected && (
        <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 8 }}>
          <span
            style={{
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
              color: trackColor(state),
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: trackColor(state) }} />
            {trackLabel(state)}
          </span>
        </div>
      )}
      <div style={{ position: 'absolute', top: 12, right: 12 }}>
        <Badge tone={connected ? 'danger' : 'neutral'}>● REC</Badge>
      </div>
    </div>
  );
}
