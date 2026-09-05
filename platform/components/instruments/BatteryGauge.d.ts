import * as React from 'react';

export interface BatteryGaugeProps {
  /** Remaining charge, 0..100. */
  remaining?: number;
  /** Pack voltage (V). */
  voltage?: number | null;
  /** Current draw (A). */
  current?: number | null;
  /** Cell count, e.g. 4 → "4S". */
  cells?: number | null;
  /** Tighter layout for the top status bar. */
  compact?: boolean;
}

/**
 * Battery bar with colour-coded remaining % and V/A readouts. Amber ≤30%,
 * red ≤15% (pulses). Drive from `telemetry.battery`.
 */
export function BatteryGauge(props: BatteryGaugeProps): React.ReactElement;
