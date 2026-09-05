import * as React from 'react';

export interface GaugeReadoutProps {
  /** Uppercase micro-label above the value. */
  label: React.ReactNode;
  /** The numeric value (pre-formatted string or number). */
  value: React.ReactNode;
  /** Unit suffix (m, m/s, %, V…). */
  unit?: string;
  /** Status colour for the value. */
  status?: 'default' | 'nominal' | 'caution' | 'danger' | 'accent' | 'muted';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Optional trend caret. */
  trend?: 'up' | 'down' | null;
  align?: 'left' | 'right';
  style?: React.CSSProperties;
}

/**
 * Labelled numeric telemetry readout with tabular mono figures (no jitter as
 * digits change). The standard way to show any live number in the GCS.
 *
 * @startingPoint section="Telemetry" subtitle="Numeric readout — label + tabular value + unit" viewport="700x130"
 */
export function GaugeReadout(props: GaugeReadoutProps): React.ReactElement;
