import * as React from 'react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Icon node (e.g. lucide icon at size 16). */
  icon: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'solid';
  /** Toggled-on appearance (accent tint). */
  active?: boolean;
  /** Accessible label — also the tooltip. */
  title?: string;
}

/** Square icon-only control for toolbars, panel headers, map controls. */
export function IconButton(props: IconButtonProps): React.ReactElement;
