/**
 * BatteryGauge — horizontal cell with a colour-coded level bar, the remaining
 * percentage in tabular mono and (when known, and not compact) the pack
 * voltage / current beneath.
 *
 * Thresholds: ≤ 30 % caution (amber), ≤ 15 % critical (red, pulsing via the
 * shared eis-batpulse keyframes). All colour and size choices are
 * `.eis-batt` rules keyed on `data-status` / `data-compact`; the level is a
 * `--batt-pct` custom property.
 */

import type { CSSProperties } from 'react';

type StyleWithVars = CSSProperties & { [name: `--${string}`]: string | number };

export interface BatteryGaugeProps {
  remaining?: number;
  voltage?: number | null;
  current?: number | null;
  cells?: number | null;
  compact?: boolean;
}

export type BatteryStatus = 'nominal' | 'caution' | 'critical';

export const BATTERY_CAUTION_PCT = 30;
export const BATTERY_CRITICAL_PCT = 15;

/** Colour band for a remaining-charge percentage. */
export function batteryStatus(remainingPct: number): BatteryStatus {
  if (remainingPct <= BATTERY_CRITICAL_PCT) return 'critical';
  if (remainingPct <= BATTERY_CAUTION_PCT) return 'caution';
  return 'nominal';
}

/** Bar width in percent: at least a 2 % sliver so an empty pack is still visibly a bar, never above the cell. */
export function batteryFillPercent(remainingPct: number): number {
  if (!Number.isFinite(remainingPct)) return 2;
  return Math.min(100, Math.max(2, remainingPct));
}

export function BatteryGauge({ remaining = 100, voltage = null, current = null, cells = null, compact = false }: BatteryGaugeProps) {
  const status = batteryStatus(remaining);
  const showMeta = !compact && (voltage != null || current != null);
  const level: StyleWithVars = { '--batt-pct': `${batteryFillPercent(remaining)}%` };

  return (
    <div className="eis-batt" data-status={status} data-compact={compact || undefined} style={level}>
      <div className="eis-batt-head">
        <span className="eis-label">Battery</span>
        <span className="eis-batt-pct">
          <span className="eis-readout">{Math.round(remaining)}</span>
          <span className="eis-batt-unit">%</span>
        </span>
      </div>

      <div className="eis-batt-body" role="meter" aria-label="Battery remaining" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)}>
        <div className="eis-batt-cell">
          <div className="eis-batt-level" />
        </div>
        <div className="eis-batt-cap" />
      </div>

      {showMeta && (
        <div className="eis-batt-meta">
          {voltage != null && (
            <span>
              {voltage.toFixed(1)}<i> V</i>
              {cells != null && <i> · {cells}S</i>}
            </span>
          )}
          {current != null && (
            <span>
              {current.toFixed(1)}<i> A</i>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
