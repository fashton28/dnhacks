import type { CSSProperties, ReactNode } from 'react';

/**
 * Badge — compact count / tag label; lighter than a StatusPill, no dot.
 * `mono` switches to the numeric face (identifiers, counts, "12 · 40%")
 * and drops the uppercase transform.
 */

export type BadgeTone = 'neutral' | 'accent' | 'nominal' | 'caution' | 'danger' | 'outline';

export interface BadgeProps {
  children?: ReactNode;
  tone?: BadgeTone;
  mono?: boolean;
  style?: CSSProperties;
}

export function Badge({ children, tone = 'neutral', mono = false, style }: BadgeProps) {
  return (
    <span className="eis-badge" data-tone={tone} data-mono={mono || undefined} style={style}>
      {children}
    </span>
  );
}
