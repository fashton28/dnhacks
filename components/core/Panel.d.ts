import * as React from 'react';

export interface PanelProps {
  /** Uppercase micro-label shown in the header strip. */
  title?: React.ReactNode;
  /** Leading icon in the header. */
  icon?: React.ReactNode;
  /** Right-aligned header actions (IconButtons, StatusPills). */
  actions?: React.ReactNode;
  /** Status node placed just after the title. */
  status?: React.ReactNode;
  children?: React.ReactNode;
  /** Pad the body (default true). Set false for full-bleed content (video/map). */
  pad?: boolean;
  /** Make the body scroll. */
  scroll?: boolean;
  variant?: 'default' | 'raised' | 'sunken' | 'flush';
  bodyStyle?: React.CSSProperties;
  style?: React.CSSProperties;
}

/**
 * Core surface container — titled header strip over a content body. The
 * building block for every region of the GCS (telemetry, controls, log…).
 *
 * @startingPoint section="Layout" subtitle="Titled panel container — header + body, 4 variants" viewport="700x220"
 */
export function Panel(props: PanelProps): React.ReactElement;
