import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

/**
 * Button — the GCS's ordinary click control.
 *
 * Intent is expressed through `variant`; `danger` is reserved for actions
 * that destroy something (it is never the "stop" control — stopping uses the
 * always-instant secondary/danger-soft buttons the panels own).
 *
 * The element carries its variant, size and layout as data-attributes and
 * `.eis-btn` in index.css does the rest, including hover / active / disabled
 * colours through pseudo-classes. Any `style` a caller passes lands on the
 * element as inline CSS and therefore wins over the class rules, which is how
 * the panels nudge alignment (`justifyContent`, `marginLeft`) without a prop.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
  pending?: boolean;
  style?: CSSProperties;
}

const VARIANTS: ReadonlySet<string> = new Set<ButtonVariant>(['primary', 'secondary', 'ghost', 'danger', 'danger-soft']);
const SIZES: ReadonlySet<string> = new Set<ButtonSize>(['sm', 'md', 'lg']);

/** Unknown values (a stale caller, a typo that slipped past a cast) fall back to the default look. */
export function buttonVariant(v: string | undefined): ButtonVariant {
  return v !== undefined && VARIANTS.has(v) ? (v as ButtonVariant) : 'secondary';
}
export function buttonSize(s: string | undefined): ButtonSize {
  return s !== undefined && SIZES.has(s) ? (s as ButtonSize) : 'md';
}

export function Button({
  variant,
  size,
  icon = null,
  iconRight = null,
  block = false,
  pending = false,
  disabled = false,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  // A pending button is inert: the click that started the request must not
  // be able to fire it twice, and the spinner takes the leading icon's slot.
  const inert = disabled || pending;
  const classes = className ? `eis-btn ${className}` : 'eis-btn';

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={inert}
      aria-busy={pending || undefined}
      data-variant={buttonVariant(variant)}
      data-size={buttonSize(size)}
      data-block={block || undefined}
    >
      {pending ? <span className="eis-spin" aria-hidden="true" /> : icon}
      {children != null && <span>{children}</span>}
      {pending ? null : iconRight}
    </button>
  );
}
