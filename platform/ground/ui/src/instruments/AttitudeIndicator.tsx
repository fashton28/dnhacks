import { useId } from 'react';

/**
 * AttitudeIndicator — artificial horizon in SVG.
 *
 * The dial is drawn in a centred coordinate system (viewBox origin at the
 * middle). A sky-filled disc sits still; the ground half-plane, horizon line
 * and pitch ladder are one group that rotates with roll and slides with
 * pitch. On top: a roll arc with bank pointer (rotates with roll only) and
 * the fixed aircraft glyph. Motion glides through `.eis-needle`.
 *
 * Every id inside the <defs> is unique per instance (useId), so two dials on
 * one page never share a clip path or gradient.
 */

export interface AttitudeIndicatorProps {
  roll?: number;
  pitch?: number;
  size?: number;
  label?: boolean;
}

/** "+12°" / "-3°" — always signed, rounded, never "-0". */
export function signedDegrees(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}${Math.abs(rounded)}°`;
}

/** Vertical pixels per degree of pitch for a dial of `size` px (70° spans the dial). */
export function pitchScale(size: number): number {
  return size / 70;
}

export interface LadderMark { deg: number; y: number; width: number }

/**
 * Pitch-ladder rungs at ±10/±20/±30°. Positive pitch (nose up) moves the
 * horizon DOWN the dial, so the +10 rung is above the centre (negative y).
 * Rungs on multiples of 20° are the wide ones.
 */
export function pitchLadder(pxPerDeg: number, stepDeg = 10, maxDeg = 30): LadderMark[] {
  const marks: LadderMark[] = [];
  for (let deg = -maxDeg; deg <= maxDeg; deg += stepDeg) {
    if (deg === 0) continue;
    marks.push({ deg, y: -deg * pxPerDeg, width: deg % 20 === 0 ? 34 : 20 });
  }
  return marks;
}

/** One SVG path for every ladder rung — a single element instead of one per rung. */
export function ladderPath(marks: readonly LadderMark[]): string {
  return marks.map((m) => `M${-m.width / 2} ${m.y}H${m.width / 2}`).join('');
}

/** Cartesian point on a circle of radius `r`, with 0° at 12 o'clock and clockwise positive. */
export function polar(deg: number, r: number): { x: number; y: number } {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

/** Radial tick marks between radii `outer` and `outer - len`, as one path string. */
export function radialTicks(angles: readonly number[], outer: number, len: number): string {
  return angles
    .map((deg) => {
      const a = polar(deg, outer);
      const b = polar(deg, outer - len);
      return `M${a.x.toFixed(2)} ${a.y.toFixed(2)}L${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
    })
    .join('');
}

const BANK_MAJOR = [-60, -30, 30, 60] as const;
const BANK_MINOR = [-45, -20, -10, 10, 20, 45] as const;

export function AttitudeIndicator({ roll = 0, pitch = 0, size = 200, label = true }: AttitudeIndicatorProps) {
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const clipId = `ai-clip-${uid}`;
  const skyId = `ai-sky-${uid}`;
  const gndId = `ai-gnd-${uid}`;

  const r = size / 2;
  const pxPerDeg = pitchScale(size);
  const reach = r * 4;                       // half-plane big enough for any pitch/roll
  const ladder = ladderPath(pitchLadder(pxPerDeg));
  const tip = polar(0, r - 4);               // bank pointer apex on the arc

  return (
    <div className="eis-instrument">
      <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} role="img" aria-label={`Attitude roll ${signedDegrees(roll)} pitch ${signedDegrees(pitch)}`}>
        <defs>
          <clipPath id={clipId}><circle r={r - 3} /></clipPath>
          <linearGradient id={skyId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#2f6db0" />
            <stop offset="1" stopColor="#4f93cf" />
          </linearGradient>
          <linearGradient id={gndId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7a5a32" />
            <stop offset="1" stopColor="#5a4124" />
          </linearGradient>
        </defs>

        <circle r={r - 1} fill="#0b0d11" />

        {/* horizon ball: sky disc under a rolling, sliding ground half-plane */}
        <g clipPath={`url(#${clipId})`}>
          <circle r={r - 3} fill={`url(#${skyId})`} />
          <g className="eis-needle" transform={`rotate(${-roll}) translate(0 ${pitch * pxPerDeg})`}>
            <rect x={-reach} y={0} width={reach * 2} height={reach} fill={`url(#${gndId})`} />
            <path d={`M${-reach} 0H${reach}`} stroke="#eef3f8" strokeWidth={1.5} />
            <path d={ladder} stroke="rgba(255,255,255,0.85)" strokeWidth={1.2} fill="none" />
          </g>
        </g>

        {/* roll arc + bank pointer */}
        <g className="eis-needle" transform={`rotate(${-roll})`} stroke="rgba(255,255,255,0.7)" fill="none">
          <path d={radialTicks(BANK_MAJOR, r - 4, 9)} strokeWidth={1.2} />
          <path d={radialTicks(BANK_MINOR, r - 4, 5)} strokeWidth={1.2} />
          <path d={radialTicks([0], r - 4, 9)} strokeWidth={2} />
          <polygon points={`${tip.x},${tip.y} -6,${-r + 14} 6,${-r + 14}`} fill="#fff" stroke="none" />
        </g>

        {/* fixed aircraft reference */}
        <g stroke="var(--amber-bright)" strokeWidth={2.5} fill="none" strokeLinecap="round">
          <path d={`M${-r * 0.42} 0H${-r * 0.16}M${r * 0.16} 0H${r * 0.42}`} />
          <circle r={2.2} fill="var(--amber-bright)" stroke="none" />
        </g>
        <polygon points="0,-7 -5,2 5,2" transform={`translate(0 ${-r + 16})`} fill="var(--amber-bright)" />

        <circle r={r - 1} fill="none" stroke="var(--border-strong)" strokeWidth={1} />
      </svg>

      {label && (
        <div className="eis-instrument-caption">
          <Mini label="ROLL" value={signedDegrees(roll)} />
          <Mini label="PITCH" value={signedDegrees(pitch)} />
        </div>
      )}
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="eis-mini">
      <span className="eis-label">{label}</span>
      <span className="eis-readout">{value}</span>
    </div>
  );
}
