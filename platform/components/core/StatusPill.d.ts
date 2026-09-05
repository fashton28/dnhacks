import * as React from 'react';

export type StatusKind =
  | 'nominal' | 'caution' | 'danger' | 'critical' | 'info' | 'active' | 'neutral';

export interface StatusPillProps {
  /** Semantic status — drives colour. */
  status?: StatusKind;
  children?: React.ReactNode;
  /** Pulsing dot for live/active states (tracking locked, recording). */
  pulse?: boolean;
  size?: 'sm' | 'md';
  /** Filled chip instead of tinted outline. */
  solid?: boolean;
  /** Show the leading status dot (default true). */
  dot?: boolean;
  /** Replace the dot with a custom icon node. */
  icon?: React.ReactNode;
  style?: React.CSSProperties;
}

/**
 * Glanceable status chip — coloured dot + uppercase micro-label. The most-used
 * status primitive in the GCS (armed, mode, GPS fix, link, tracking state…).
 *
 * @startingPoint section="Status" subtitle="Status chip — 7 semantic kinds, pulse, solid" viewport="700x140"
 */
export function StatusPill(props: StatusPillProps): React.ReactElement;
