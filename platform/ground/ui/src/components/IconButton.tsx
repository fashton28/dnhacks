import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

/**
 * IconButton — square, icon-only control for toolbars and panel headers.
 * `title` doubles as the accessible name. Hover / active / disabled looks are
 * `.eis-iconbtn` pseudo-class rules; `active` (a toggled-on tool) is a
 * data-attribute so it survives the hover state.
 */

export type IconButtonVariant = 'ghost' | 'solid';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  icon: ReactNode;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  active?: boolean;
  title?: string;
  style?: CSSProperties;
}

export function IconButton({
  icon,
  size = 'md',
  variant = 'ghost',
  active = false,
  disabled = false,
  title,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={className ? `eis-iconbtn ${className}` : 'eis-iconbtn'}
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      disabled={disabled}
      data-size={size}
      data-variant={variant}
      data-active={active || undefined}
    >
      {icon}
    </button>
  );
}
