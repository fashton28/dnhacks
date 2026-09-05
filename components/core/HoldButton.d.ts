import * as React from 'react';

export interface HoldButtonProps {
  children?: React.ReactNode;
  /** Fires after a continuous hold of `holdMs`. */
  onConfirm?: () => void;
  /** Hold duration in ms before confirm (default 1100). */
  holdMs?: number;
  variant?: 'primary' | 'caution' | 'danger';
  icon?: React.ReactNode;
  disabled?: boolean;
  block?: boolean;
  /** Sub-label shown when idle (default "Hold to confirm"). */
  hint?: string;
  style?: React.CSSProperties;
}

/**
 * Hold-to-confirm safety control for deliberate, gated actions (Takeoff,
 * Engage Tracking). A progress fill sweeps while held; releasing early cancels.
 * NEVER use to stop something — stopping must be instant (use Button).
 *
 * @startingPoint section="Safety" subtitle="Hold-to-confirm gated action — fills while held" viewport="700x150"
 */
export function HoldButton(props: HoldButtonProps): React.ReactElement;
