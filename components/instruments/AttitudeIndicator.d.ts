import * as React from 'react';

export interface AttitudeIndicatorProps {
  /** Bank angle, degrees (+right). */
  roll?: number;
  /** Pitch angle, degrees (+nose-up). */
  pitch?: number;
  /** Diameter in px. */
  size?: number;
  /** Show ROLL/PITCH numeric readouts below. */
  label?: boolean;
}

/**
 * Artificial horizon (roll/pitch) drawn in SVG — sky/ground ball, pitch ladder,
 * roll arc + bank pointer, fixed amber aircraft glyph. Motion glides smoothly.
 *
 * @startingPoint section="Instruments" subtitle="Artificial horizon — roll/pitch attitude" viewport="700x300"
 */
export function AttitudeIndicator(props: AttitudeIndicatorProps): React.ReactElement;
