import type { CSSProperties, ReactNode } from 'react';

/**
 * GaugeReadout — a captioned numeric telemetry value. The figure uses the
 * shared `.eis-readout` face (tabular, slashed-zero mono) so digits never
 * jitter as they change; `status` colours it, `trend` adds a caret.
 */

export type GaugeReadoutStatus = 'default' | 'nominal' | 'caution' | 'danger' | 'accent' | 'muted';
export type GaugeReadoutSize = 'sm' | 'md' | 'lg' | 'xl';
export type GaugeTrend = 'up' | 'down';

export interface GaugeReadoutProps {
  label: string;
  value: ReactNode;
  unit?: string;
  status?: GaugeReadoutStatus;
  size?: GaugeReadoutSize;
  trend?: GaugeTrend | null;
  align?: 'left' | 'right';
  style?: CSSProperties;
}

const TREND_GLYPH: Record<GaugeTrend, string> = { up: '▲', down: '▼' };

/** The caret shown beside a trending value; empty when there is no trend. */
export function trendGlyph(trend: GaugeTrend | null | undefined): string {
  return trend ? TREND_GLYPH[trend] : '';
}

export function GaugeReadout({
  label,
  value,
  unit = '',
  status = 'default',
  size = 'md',
  trend = null,
  align = 'left',
  style,
}: GaugeReadoutProps) {
  const glyph = trendGlyph(trend);

  return (
    <div className="eis-gauge" data-status={status} data-size={size} data-align={align} style={style}>
      <span className="eis-label">{label}</span>
      <span className="eis-gauge-row">
        {glyph && <span className="eis-gauge-trend" aria-label={trend === 'up' ? 'rising' : 'falling'}>{glyph}</span>}
        <span className="eis-readout">{value}</span>
        {unit && <span className="eis-gauge-unit">{unit}</span>}
      </span>
    </div>
  );
}
