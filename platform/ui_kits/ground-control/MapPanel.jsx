/* MapPanel — Google-Earth-style situational map. In the live build this is
   react-leaflet over Google/OSM satellite tiles; here it's a self-contained
   procedural satellite-look canvas with home, drone (heading), target, geofence
   ring and a breadcrumb trail driven by telemetry. */
function MapPanel({ tel, tracking, home, trail }) {
  const DS = window.dnhacksPlatformDesignSystem_c7577a;
  const { Panel, IconButton, Badge } = DS;
  const Ic = window.EISIcon;
  const cvRef = React.useRef(null);
  const wrapRef = React.useRef(null);
  const stateRef = React.useRef({ tel, tracking, trail });
  stateRef.current = { tel, tracking, trail };
  const [zoom, setZoom] = React.useState(1);
  const zoomRef = React.useRef(zoom); zoomRef.current = zoom;

  React.useEffect(() => {
    let raf;
    // deterministic terrain features generated once
    const rnd = mulberry32(42);
    const fields = Array.from({ length: 16 }, () => ({
      x: rnd(), y: rnd(), r: 0.06 + rnd() * 0.12, tone: rnd(),
    }));
    const draw = () => {
      const cv = cvRef.current, wrap = wrapRef.current;
      if (!cv || !wrap) { raf = requestAnimationFrame(draw); return; }
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const W = r.width, H = r.height;
      if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // base satellite ground
      ctx.fillStyle = '#1c2a1e'; ctx.fillRect(0, 0, W, H);
      // fields / patches
      fields.forEach(f => {
        const tones = ['#243425','#2c3a26','#33402a','#3b3a28','#2a3530'];
        ctx.fillStyle = tones[Math.floor(f.tone * tones.length)];
        ctx.beginPath();
        ctx.ellipse(f.x * W, f.y * H, f.r * W, f.r * H * 0.8, f.tone * 6, 0, Math.PI * 2);
        ctx.fill();
      });
      // river
      ctx.strokeStyle = '#1c3344'; ctx.lineWidth = 13; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-10, H * 0.7);
      ctx.bezierCurveTo(W * 0.3, H * 0.5, W * 0.4, H * 0.9, W * 0.7, H * 0.62);
      ctx.bezierCurveTo(W * 0.85, H * 0.5, W * 0.95, H * 0.6, W + 10, H * 0.55); ctx.stroke();
      // roads
      ctx.strokeStyle = 'rgba(180,180,170,0.18)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(W * 0.15, -5); ctx.lineTo(W * 0.22, H + 5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-5, H * 0.3); ctx.lineTo(W + 5, H * 0.42); ctx.stroke();
      // grid
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 48) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 48) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

      const cx = W / 2, cy = H / 2;
      const z = zoomRef.current;
      const mPerPx = 0.55 / z; // scale
      const { tel: T, tracking: TK, trail: TR } = stateRef.current;
      const HOME = home;
      const toXY = (lat, lon) => {
        const dN = (lat - HOME.lat) * 111320;
        const dE = (lon - HOME.lon) * 111320 * Math.cos(HOME.lat * Math.PI / 180);
        return [cx + dE / mPerPx, cy - dN / mPerPx];
      };

      // geofence ring (radius 60 m default)
      const fenceR = 60 / mPerPx;
      ctx.setLineDash([6, 5]); ctx.strokeStyle = 'rgba(47,129,247,0.55)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cx, cy, fenceR, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(47,129,247,0.05)'; ctx.beginPath(); ctx.arc(cx, cy, fenceR, 0, Math.PI * 2); ctx.fill();

      // breadcrumb trail
      if (TR && TR.length > 1) {
        ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(90,160,255,0.7)';
        ctx.beginPath();
        TR.forEach((p, i) => { const [x, y] = toXY(p.lat, p.lon); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      }

      // home marker
      ctx.fillStyle = '#e6eaf0';
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1.5; ctx.stroke();

      // drone marker
      if (T) {
        const [dx, dy] = toXY(T.position.lat, T.position.lon);
        const hd = (T.heading || 0) * Math.PI / 180;
        // heading cone
        const g = ctx.createRadialGradient(dx, dy, 0, dx, dy, 46);
        g.addColorStop(0, 'rgba(245,166,35,0.28)'); g.addColorStop(1, 'rgba(245,166,35,0)');
        ctx.save(); ctx.translate(dx, dy); ctx.rotate(hd);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 46, -Math.PI / 2 - 0.4, -Math.PI / 2 + 0.4); ctx.closePath(); ctx.fill();
        // triangle
        ctx.fillStyle = '#ffc24b'; ctx.strokeStyle = '#0b0d11'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(6, 7); ctx.lineTo(0, 3); ctx.lineTo(-6, 7); ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.restore();
      }

      // target marker (locked)
      if (TK && TK.state === 'locked' && T) {
        // place target standoff ahead of drone along heading
        const hd = (T.heading || 0) * Math.PI / 180;
        const [dx, dy] = toXY(T.position.lat, T.position.lon);
        const tx = dx + Math.sin(hd) * (TK.estimatedDistance || 5) / mPerPx;
        const ty = dy - Math.cos(hd) * (TK.estimatedDistance || 5) / mPerPx;
        ctx.strokeStyle = '#f04438'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(tx, ty, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(tx - 11, ty); ctx.lineTo(tx + 11, ty); ctx.moveTo(tx, ty - 11); ctx.lineTo(tx, ty + 11); ctx.stroke();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [home]);

  return (
    <Panel title="Situational map" variant="sunken" pad={false}
      actions={<><Badge tone="outline" mono>SAT</Badge><IconButton size="sm" icon={<Ic d={<><line x1="5" y1="12" x2="19" y2="12"/><line x1="12" y1="5" x2="12" y2="19"/></>} s={15} />} title="Zoom in" onClick={() => setZoom(z => Math.min(3, z + 0.3))} /><IconButton size="sm" icon={<Ic d={<line x1="5" y1="12" x2="19" y2="12"/>} s={15} />} title="Zoom out" onClick={() => setZoom(z => Math.max(0.6, z - 0.3))} /></>}
      style={{ height: '100%' }} bodyStyle={{ position: 'relative' }}>
      <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
        <canvas ref={cvRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        {/* legend */}
        <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 9px', background: 'rgba(8,12,16,0.72)', backdropFilter: 'blur(6px)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)' }}>
          <Leg color="#ffc24b" label="Drone" />
          <Leg color="#e6eaf0" label="Home" />
          <Leg color="#f04438" label="Target" />
          <Leg color="rgba(47,129,247,0.8)" label="Geofence 60 m" dash />
        </div>
        <div style={{ position: 'absolute', right: 10, top: 10, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)', background: 'rgba(8,12,16,0.6)', padding: '3px 6px', borderRadius: 3 }}>
          {tel ? `${tel.position.lat.toFixed(4)}, ${tel.position.lon.toFixed(4)}` : '—'}
        </div>
      </div>
    </Panel>
  );
}

function Leg({ color, label, dash }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{ width: 12, height: dash ? 0 : 8, borderRadius: dash ? 0 : '50%', background: dash ? 'transparent' : color, borderTop: dash ? `2px dashed ${color}` : 'none', flex: 'none' }} />
      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{label}</span>
    </div>
  );
}
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

Object.assign(window, { MapPanel });
