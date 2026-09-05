import * as React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual intent. `danger` is reserved for destructive actions only. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon node (e.g. a lucide icon). */
  icon?: React.ReactNode;
  /** Trailing icon node. */
  iconRight?: React.ReactNode;
  /** Full-width. */
  block?: boolean;
  /** Shows a spinner and disables interaction (command in flight). */
  pending?: boolean;
  disabled?: boolean;
}

/**
 * Primary action control. Use one `primary` button per region; `secondary`
 * for the rest; `ghost` for low-emphasis; `danger` strictly for destructive ops.
 *
 * @startingPoint section="Controls" subtitle="Action button — 5 intents, 3 sizes, pending state" viewport="700x150"
 */
export function Button(props: ButtonProps): React.ReactElement;
