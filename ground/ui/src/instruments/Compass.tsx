import React from 'react';

interface CompassProps {
  heading?: number;
  size?: number;
  target?: number | null;
  label?: boolean;
}

/**
 * Compass — heading rose (SVG). A rotating card with N/E/S/W + tick ring under
 * a fixed lubber line; large mono heading readout in the centre.
 */
export function Compass({ heading = 0, size = 200, target = null, label = true }: CompassProps) {
  const r = size / 2;
  const ticks: Array<{ d: number; major: boolean }> = [];
  for (let d = 0; d < 360; d += 5) {
    const major = d % 30 === 0;
    ticks.push({ d, major });
  }
  const cardinals: Array<{ d: number; t: string; c: string }> = [
    { d: 0,   t: 'N', c: 'var(--red-bright)' },
    { d: 90,  t: 'E', c: 'var(--text-secondary)' },
    { d: 180, t: 'S', c: 'var(--text-secondary)' },
    { d: 270, t: 'W', c: 'var(--text-secondary)' },
  ];

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`}>
        <circle cx={0} cy={0} r={r - 1} fill="#0b0d11" stroke="var(--border-strong)" strokeWidth={1} />

        {/* rotating card */}
        <g transform={`rotate(${-heading})`} style={{ transition: 'transform var(--needle-ease) 120ms' }}>
          {ticks.map((t) => {
            const a = (t.d - 90) * Math.PI / 180;
            const len = t.major ? 10 : 5;
            const r1 = r - 6, r2 = r - 6 - len;
            return (
              <line key={t.d}
                x1={Math.cos(a) * r1} y1={Math.sin(a) * r1}
                x2={Math.cos(a) * r2} y2={Math.sin(a) * r2}
                stroke={t.major ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)'} strokeWidth={t.major ? 1.4 : 1} />
            );
          })}
          {cardinals.map((c) => {
            const a = (c.d - 90) * Math.PI / 180;
            const rr = r - 30;
            return (
              <text key={c.t}
                x={Math.cos(a) * rr} y={Math.sin(a) * rr}
                fill={c.c} fontFamily="var(--font-sans)" fontSize={size * 0.085} fontWeight={700}
                textAnchor="middle" dominantBaseline="central"
                transform={`rotate(${heading} ${Math.cos(a) * rr} ${Math.sin(a) * rr})`}>
                {c.t}
              </text>
            );
          })}
          {/* target bearing marker */}
          {target != null && (() => {
            const a = (target - 90) * Math.PI / 180;
            return (
              <polygon
                points="0,-7 -5,3 5,3"
                fill="var(--accent)"
                transform={`translate(${Math.cos(a) * (r - 6)} ${Math.sin(a) * (r - 6)}) rotate(${target})`}
              />
            );
          })()}
        </g>

        {/* fixed lubber line */}
        <polygon points={`0,${-r + 4} -5,${-r + 14} 5,${-r + 14}`} fill="var(--amber-bright)" />

        {/* center readout */}
        <text x={0} y={-2} textAnchor="middle" dominantBaseline="central"
          fill="var(--text-primary)" fontFamily="var(--font-mono)" fontSize={size * 0.22} fontWeight={500}
          style={{ fontVariantNumeric: 'tabular-nums' }}>
          {String(Math.round(heading)).padStart(3, '0')}
        </text>
        <text x={0} y={size * 0.16} textAnchor="middle" fill="var(--text-tertiary)" fontFamily="var(--font-sans)" fontSize={size * 0.07} fontWeight={600} letterSpacing="0.1em">HDG</text>
      </svg>
      {label && (
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)', color: 'var(--text-tertiary)' }}>HEADING</span>
      )}
    </div>
  );
}
