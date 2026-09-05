import React from 'react';

/**
 * AttitudeIndicator — artificial horizon (roll/pitch) drawn in SVG.
 * Sky/ground tilt with roll and translate with pitch; a fixed aircraft glyph,
 * pitch ladder, and roll arc with bank pointer sit on top. Needle motion glides.
 */
export function AttitudeIndicator({ roll = 0, pitch = 0, size = 200, label = true }) {
  const r = size / 2;
  const pxPerDeg = size / 70;          // vertical px per degree of pitch
  const clip = `eis-ai-clip`;

  // pitch ladder marks
  const ladder = [];
  for (let d = -30; d <= 30; d += 10) {
    if (d === 0) continue;
    const w = d % 20 === 0 ? 34 : 20;
    ladder.push({ d, w, y: -d * pxPerDeg });
  }
  // roll arc ticks
  const rollTicks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} style={{ display: 'block' }}>
        <defs>
          <clipPath id={clip}><circle cx={0} cy={0} r={r - 3} /></clipPath>
          <linearGradient id="eis-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2f6db0" />
            <stop offset="1" stopColor="#4f93cf" />
          </linearGradient>
          <linearGradient id="eis-gnd" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7a5a32" />
            <stop offset="1" stopColor="#5a4124" />
          </linearGradient>
        </defs>

        <circle cx={0} cy={0} r={r - 1} fill="#0b0d11" />

        {/* rotating + translating horizon ball */}
        <g clipPath={`url(#${clip})`}>
          <g style={{ transition: 'transform var(--needle-ease) 120ms' }} transform={`rotate(${-roll})`}>
            <g transform={`translate(0 ${pitch * pxPerDeg})`}>
              <rect x={-r * 2} y={-r * 4} width={r * 4} height={r * 4} fill="url(#eis-sky)" />
              <rect x={-r * 2} y={0} width={r * 4} height={r * 4} fill="url(#eis-gnd)" />
              <line x1={-r * 2} y1={0} x2={r * 2} y2={0} stroke="#eef3f8" strokeWidth={1.5} />
              {/* pitch ladder */}
              {ladder.map((m) => (
                <g key={m.d} stroke="rgba(255,255,255,0.85)" strokeWidth={1.2}>
                  <line x1={-m.w / 2} y1={m.y} x2={m.w / 2} y2={m.y} />
                </g>
              ))}
            </g>
          </g>
        </g>

        {/* roll arc */}
        <g transform={`rotate(${-roll})`} style={{ transition: 'transform var(--needle-ease) 120ms' }}>
          {rollTicks.map((t) => {
            const a = (t - 90) * Math.PI / 180;
            const len = t % 30 === 0 ? 9 : 5;
            const r1 = r - 4, r2 = r - 4 - len;
            return (
              <line key={t}
                x1={Math.cos(a) * r1} y1={Math.sin(a) * r1}
                x2={Math.cos(a) * r2} y2={Math.sin(a) * r2}
                stroke="rgba(255,255,255,0.7)" strokeWidth={t === 0 ? 2 : 1.2} />
            );
          })}
          {/* bank pointer (triangle at top) */}
          <polygon points={`0,${-r + 4} -6,${-r + 14} 6,${-r + 14}`} fill="#fff" />
        </g>

        {/* fixed aircraft reference */}
        <g stroke="var(--amber-bright)" strokeWidth={2.5} fill="none" strokeLinecap="round">
          <line x1={-r * 0.42} y1={0} x2={-r * 0.16} y2={0} />
          <line x1={r * 0.16} y1={0} x2={r * 0.42} y2={0} />
          <circle cx={0} cy={0} r={2.2} fill="var(--amber-bright)" stroke="none" />
        </g>
        <polygon points="0,-7 -5,2 5,2" transform={`translate(0 ${-r + 16})`} fill="var(--amber-bright)" />

        {/* bezel */}
        <circle cx={0} cy={0} r={r - 1} fill="none" stroke="var(--border-strong)" strokeWidth={1} />
      </svg>
      {label && (
        <div style={{ display: 'flex', gap: 16 }}>
          <Mini label="ROLL" value={`${roll >= 0 ? '+' : ''}${roll.toFixed(0)}°`} />
          <Mini label="PITCH" value={`${pitch >= 0 ? '+' : ''}${pitch.toFixed(0)}°`} />
        </div>
      )}
    </div>
  );
}

function Mini({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)', color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}
