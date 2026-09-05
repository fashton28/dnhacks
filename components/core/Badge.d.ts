import * as React from 'react';

export interface BadgeProps {
  children?: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'nominal' | 'caution' | 'danger' | 'outline';
  /** Use mono font + no uppercase (for counts / versions / IDs). */
  mono?: boolean;
  style?: React.CSSProperties;
}

/** Compact tag/count label — lighter than StatusPill, no status dot. */
export function Badge(props: BadgeProps): React.ReactElement;
