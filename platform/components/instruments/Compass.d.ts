import * as React from 'react';

export interface CompassProps {
  /** Current heading, degrees 0..360. */
  heading?: number;
  size?: number;
  /** Optional bearing-to-target marker (degrees). */
  target?: number | null;
  label?: boolean;
}

/**
 * Heading compass rose (SVG) — rotating card with cardinal letters + tick ring
 * under a fixed lubber line, with a large mono heading readout in the centre.
 */
export function Compass(props: CompassProps): React.ReactElement;
