import * as React from 'react';

export interface SignalGaugeProps {
  /** RSSI in dBm (~-100 weak … -40 strong). */
  rssi?: number;
  /** Round-trip latency, ms. */
  latencyMs?: number | null;
  /** Force link-lost state. */
  lost?: boolean;
  label?: string;
  /** Bars only, no text (status bar). */
  compact?: boolean;
}

/** Link-quality bars from RSSI + latency readout; shows LOST when link drops. */
export function SignalGauge(props: SignalGaugeProps): React.ReactElement;
