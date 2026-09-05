/* VideoPanel — synthetic forward-view canvas scene + tracking overlay.
   Draws a believable scene with people at the mock's bbox positions, renders
   DOM bounding boxes for hover/click-to-select, crosshair, and distance HUD. */
function VideoPanel({ tracking, connState, standoff, onSelectTarget }) {
  const canvasRef = React.useRef(null);
  const trackRef = React.useRef(tracking);
  trackRef.current = tracking;
  const sizeRef = React.useRef({ w: 800, h: 450 });
  const [box, setBox] = React.useState({ w: 800, h: 450 });

  // resize observer
  const wrapRef = React.useRef(null);
  React.useEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // canvas scene animation
  React.useEffect(() => {
    let raf, t = 0;
    const draw = () => {
      const cv = canvasRef.current; if (!cv) { raf = requestAnimationFrame(draw); return; }
      const { w, h } = sizeRef.current;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      t += 0.016;
      const connected = connState === 'connected';

      // sky → ground gradient
      const horizon = h * 0.42;
      const g2 = ctx.createLinearGradient(0, 0, 0, horizon);
      g2.addColorStop(0, '#0e1c28'); g2.addColorStop(1, '#26323a');
      ctx.fillStyle = g2; ctx.fillRect(0, 0, w, horizon);
      // ground
      const grd = ctx.createLinearGradient(0, horizon, 0, h);
      grd.addColorStop(0, '#2a3a30'); grd.addColorStop(1, '#161f1a');
      ctx.fillStyle = grd; ctx.fillRect(0, horizon, w, h - horizon);
      // perspective ground lines
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
      for (let i = -6; i <= 6; i++) {
        ctx.beginPath(); ctx.moveTo(w / 2, horizon);
        ctx.lineTo(w / 2 + i * w * 0.16, h); ctx.stroke();
      }
      for (let j = 1; j <= 5; j++) {
        const yy = horizon + (h - horizon) * (j / 5) * (j / 5);
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
      }

      // draw people from tracking targets
      if (connected) {
        const tk = trackRef.current;
        (tk?.targets || []).forEach(tgt => {
          const [nx, ny, nw, nh] = tgt.bbox;
          const px = nx * w, py = ny * h, pw = nw * w, ph = nh * h;
          // shadow
          ctx.fillStyle = 'rgba(0,0,0,0.35)';
          ctx.beginPath(); ctx.ellipse(px + pw / 2, py + ph, pw * 0.5, ph * 0.08, 0, 0, Math.PI * 2); ctx.fill();
          // body
          ctx.fillStyle = tgt.isLocked ? '#3a4654' : '#34404c';
          roundRect(ctx, px + pw * 0.22, py + ph * 0.28, pw * 0.56, ph * 0.72, pw * 0.18); ctx.fill();
          // head
          ctx.fillStyle = '#414f5e';
          ctx.beginPath(); ctx.arc(px + pw / 2, py + ph * 0.16, pw * 0.22, 0, Math.PI * 2); ctx.fill();
        });
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [connState]);

  const connected = connState === 'connected';
  const state = tracking?.state || 'idle';
  const { Badge } = window.dnhacksPlatformDesignSystem_c7577a;

  // border treatment per tracking state
  const borderColor = !connected ? 'transparent'
    : state === 'locked' ? 'var(--amber)'
    : state === 'searching' ? 'var(--accent)'
    : state === 'lost' ? 'var(--red)' : 'transparent';

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', background: '#0a1016' }}>
      <canvas ref={canvasRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: connected ? 'block' : 'none' }} />

      {/* active-tracking pulsing border */}
      {connected && (state === 'locked' || state === 'searching' || state === 'lost') && (
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          boxShadow: `inset 0 0 0 2px ${borderColor}`,
          animation: state === 'locked' ? 'eis-trackpulse 1.3s ease-in-out infinite' : 'none',
        }}>
          <style>{`@keyframes eis-trackpulse{0%,100%{opacity:.5}50%{opacity:1}}`}</style>
        </div>
      )}

      {/* no-signal / disconnected */}
      {!connected && (
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
      {connected && (tracking?.targets || []).map(tgt => {
        const [nx, ny, nw, nh] = tgt.bbox;
        const locked = tgt.isLocked;
        return (
          <button key={tgt.id}
            onClick={() => onSelectTarget(tgt.id)}
            title={`Select target #${tgt.id}`}
            style={{
              position: 'absolute',
              left: `${nx * 100}%`, top: `${ny * 100}%`,
              width: `${nw * 100}%`, height: `${nh * 100}%`,
              border: `1.5px solid ${locked ? 'var(--amber-bright)' : 'rgba(255,255,255,0.6)'}`,
              borderRadius: 2, background: 'transparent', cursor: 'pointer', padding: 0,
              boxShadow: locked ? '0 0 0 1px rgba(0,0,0,0.5), 0 0 14px rgba(245,166,35,0.4)' : 'none',
              transition: 'border-color var(--dur-fast)',
            }}>
            {/* corner ticks */}
            {locked && [['0','0'],['100%','0'],['0','100%'],['100%','100%']].map(([x,y],i)=>(
              <span key={i} style={{ position:'absolute', left:x, top:y, width:7, height:7, transform:`translate(${x==='0'?'-1px':'-6px'},${y==='0'?'-1px':'-6px'})`, borderLeft: x==='0'?'2px solid var(--amber-bright)':'none', borderRight:x!=='0'?'2px solid var(--amber-bright)':'none', borderTop:y==='0'?'2px solid var(--amber-bright)':'none', borderBottom:y!=='0'?'2px solid var(--amber-bright)':'none' }} />
            ))}
            <span style={{
              position: 'absolute', top: -18, left: -1.5,
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '1px 5px', height: 16,
              background: locked ? 'var(--amber)' : 'rgba(0,0,0,0.7)',
              color: locked ? '#1a1205' : '#fff',
              fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 600, borderRadius: 2, whiteSpace: 'nowrap',
            }}>
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
        <div style={{
          position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)',
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '7px 14px', background: 'rgba(8,12,16,0.78)', backdropFilter: 'blur(6px)',
          border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
          fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
        }}>
          <HudVal label="DIST" value={tracking.estimatedDistance.toFixed(1)} unit="m" color="var(--amber-bright)" />
          <div style={{ width: 1, height: 22, background: 'var(--border-default)' }} />
          <HudVal label="STANDOFF" value={standoff.toFixed(1)} unit="m" color="var(--text-secondary)" />
        </div>
      )}

      {/* top-left state chip */}
      {connected && (
        <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', gap: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 9px', background: 'rgba(8,12,16,0.7)', backdropFilter: 'blur(6px)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-pill)', fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: trackColor(state) }}>
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

function HudVal({ label, value, unit, color }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 500, color }}>{value}<span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}> {unit}</span></span>
    </div>
  );
}
function trackColor(s){return s==='locked'?'var(--amber-bright)':s==='searching'?'var(--accent-text)':s==='lost'?'var(--red-bright)':'var(--text-tertiary)';}
function trackLabel(s){return s==='locked'?'Tracking · Locked':s==='searching'?'Searching':s==='lost'?'Target Lost':'Tracking Idle';}
function roundRect(ctx,x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}

Object.assign(window, { VideoPanel });
