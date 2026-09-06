import { polar, radialTicks } from './AttitudeIndicator';

/**
 * Compass — heading rose in SVG. A card carrying the tick ring, the cardinal
 * letters and the optional target-bearing marker rotates so the current
 * heading sits under a fixed lubber line at the top; the centre shows the
 * heading as a three-digit readout. Card motion glides through `.eis-needle`.
 */

export interface CompassProps {
  heading?: number;
  size?: number;
  target?: number | null;
  label?: boolean;
}

/** Heading folded into [0, 360) — 372 → 12, -10 → 350. */
export function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Three-digit, zero-padded readout ("007", "270"); "---" when there is no valid heading. */
export function formatHeading(deg: number): string {
  if (!Number.isFinite(deg)) return '---';
  return String(normalizeHeading(Math.round(deg))).padStart(3, '0');
}

/** Angles of the tick ring: `every` degrees, split into major (multiples of `majorEvery`) and minor. */
export function compassTicks(every = 5, majorEvery = 30): { major: number[]; minor: number[] } {
  const major: number[] = [];
  const minor: number[] = [];
  for (let deg = 0; deg < 360; deg += every) (deg % majorEvery === 0 ? major : minor).push(deg);
  return { major, minor };
}

const CARDINALS = [
  { deg: 0, glyph: 'N', color: 'var(--red-bright)' },
  { deg: 90, glyph: 'E', color: 'var(--text-secondary)' },
  { deg: 180, glyph: 'S', color: 'var(--text-secondary)' },
  { deg: 270, glyph: 'W', color: 'var(--text-secondary)' },
] as const;

export function Compass({ heading = 0, size = 200, target = null, label = true }: CompassProps) {
  const r = size / 2;
  const ring = r - 6;
  const ticks = compassTicks();
  const lubber = polar(0, r - 4);
  const marker = target == null ? null : polar(target, ring);

  return (
    <div className="eis-instrument">
      <svg width={size} height={size} viewBox={`${-r} ${-r} ${size} ${size}`} role="img" aria-label={`Heading ${formatHeading(heading)}`}>
        <circle r={r - 1} fill="#0b0d11" stroke="var(--border-strong)" strokeWidth={1} />

        {/* rotating card */}
        <g className="eis-needle" transform={`rotate(${-heading})`}>
          <path d={radialTicks(ticks.major, ring, 10)} stroke="rgba(255,255,255,0.55)" strokeWidth={1.4} fill="none" />
          <path d={radialTicks(ticks.minor, ring, 5)} stroke="rgba(255,255,255,0.22)" strokeWidth={1} fill="none" />
          {CARDINALS.map((c) => {
            const at = polar(c.deg, r - 30);
            // Counter-rotate each letter about its own anchor so it stays upright as the card turns.
            return (
              <text
                key={c.glyph}
                x={at.x}
                y={at.y}
                fill={c.color}
                fontFamily="var(--font-sans)"
                fontSize={size * 0.085}
                fontWeight={700}
                textAnchor="middle"
                dominantBaseline="central"
                transform={`rotate(${heading} ${at.x} ${at.y})`}
              >
                {c.glyph}
              </text>
            );
          })}
          {marker && target != null && (
            <polygon
              points="0,-7 -5,3 5,3"
              fill="var(--accent)"
              transform={`translate(${marker.x} ${marker.y}) rotate(${target})`}
            />
          )}
        </g>

        {/* fixed lubber line */}
        <polygon points={`${lubber.x},${lubber.y} -5,${-r + 14} 5,${-r + 14}`} fill="var(--amber-bright)" />

        {/* centre readout */}
        <text
          y={-2}
          textAnchor="middle"
          dominantBaseline="central"
          fill="var(--text-primary)"
          fontFamily="var(--font-mono)"
          fontSize={size * 0.22}
          fontWeight={500}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {formatHeading(heading)}
        </text>
        <text
          y={size * 0.16}
          textAnchor="middle"
          fill="var(--text-tertiary)"
          fontFamily="var(--font-sans)"
          fontSize={size * 0.07}
          fontWeight={600}
          letterSpacing="0.1em"
        >
          HDG
        </text>
      </svg>

      {label && <span className="eis-label">HEADING</span>}
    </div>
  );
}
