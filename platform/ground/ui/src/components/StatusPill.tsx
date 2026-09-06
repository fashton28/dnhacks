import type { CSSProperties, ReactNode } from 'react';

/**
 * StatusPill — the glanceable status chip used throughout the GCS: a coloured
 * dot (optionally pulsing) beside an uppercase micro-label.
 *
 * Colour, size and the solid/tinted treatment are data-attributes resolved by
 * `.eis-pill`; the dot and its ping ring are pseudo-elements of
 * `.eis-pill-dot`, so the markup stays a single span per pill. An explicit
 * `icon` replaces the dot.
 */

export type StatusPillStatus = 'nominal' | 'caution' | 'danger' | 'critical' | 'info' | 'active' | 'neutral';
export type StatusPillSize = 'sm' | 'md';

export interface StatusPillProps {
  status?: StatusPillStatus;
  children?: ReactNode;
  pulse?: boolean;
  size?: StatusPillSize;
  solid?: boolean;
  dot?: boolean;
  icon?: ReactNode;
  style?: CSSProperties;
}

export function StatusPill({
  status = 'neutral',
  children,
  pulse = false,
  size = 'md',
  solid = false,
  dot = true,
  icon = null,
  style,
}: StatusPillProps) {
  const showDot = dot && icon == null;

  return (
    <span
      className="eis-pill"
      data-status={status}
      data-size={size}
      data-solid={solid || undefined}
      style={style}
    >
      {showDot && <span className="eis-pill-dot" data-pulse={pulse || undefined} aria-hidden="true" />}
      {icon}
      {children}
    </span>
  );
}
