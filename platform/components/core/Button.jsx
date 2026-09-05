import React from 'react';

/**
 * Button — primary action control for the Drone Safety Platform GCS.
 * Variants map to intent; `danger` is reserved for genuinely destructive actions.
 */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  icon = null,
  iconRight = null,
  block = false,
  pending = false,
  disabled = false,
  onClick,
  type = 'button',
  title,
  style = {},
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const isDisabled = disabled || pending;

  const heights = { sm: 'var(--control-h-sm)', md: 'var(--control-h)', lg: 'var(--control-h-lg)' };
  const fontSizes = { sm: 'var(--text-xs)', md: 'var(--text-base)', lg: 'var(--text-md)' };
  const pads = { sm: '0 10px', md: '0 14px', lg: '0 18px' };

  const palettes = {
    primary: {
      bg: 'var(--accent)', bgHover: 'var(--accent-hover)', bgActive: 'var(--accent-active)',
      fg: 'var(--text-on-accent)', border: 'transparent',
    },
    secondary: {
      bg: 'var(--surface-input)', bgHover: 'var(--surface-hover)', bgActive: 'var(--surface-raised)',
      fg: 'var(--text-primary)', border: 'var(--border-input)',
    },
    ghost: {
      bg: 'transparent', bgHover: 'var(--surface-hover)', bgActive: 'var(--surface-input)',
      fg: 'var(--text-secondary)', border: 'transparent',
    },
    danger: {
      bg: 'var(--red-deep)', bgHover: 'var(--red)', bgActive: '#b42318',
      fg: '#fff', border: 'transparent',
    },
    'danger-soft': {
      bg: 'var(--red-tint)', bgHover: 'var(--red-tint-2)', bgActive: 'var(--red-tint-2)',
      fg: 'var(--red-bright)', border: 'var(--red-line)',
    },
  };
  const p = palettes[variant] || palettes.secondary;
  const bg = isDisabled ? 'var(--surface-input)' : active ? p.bgActive : hover ? p.bgHover : p.bg;

  return (
    <button
      type={type}
      title={title}
      disabled={isDisabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{
        display: block ? 'flex' : 'inline-flex',
        width: block ? '100%' : 'auto',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '7px',
        height: heights[size],
        padding: pads[size],
        fontFamily: 'var(--font-sans)',
        fontSize: fontSizes[size],
        fontWeight: 'var(--weight-semibold)',
        letterSpacing: '0.01em',
        lineHeight: 1,
        color: isDisabled ? 'var(--text-disabled)' : p.fg,
        background: bg,
        border: `1px solid ${p.border === 'transparent' ? 'transparent' : p.border}`,
        borderRadius: 'var(--radius-md)',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.6 : 1,
        transition: 'background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
        transform: active && !isDisabled ? 'translateY(0.5px)' : 'none',
        whiteSpace: 'nowrap',
        userSelect: 'none',
        ...style,
      }}
      {...rest}
    >
      {pending ? <Spinner /> : icon}
      {children != null && <span>{children}</span>}
      {!pending && iconRight}
    </button>
  );
}

function Spinner() {
  return (
    <span
      style={{
        width: 13, height: 13, borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.35)',
        borderTopColor: '#fff',
        display: 'inline-block',
        animation: 'eis-spin 0.7s linear infinite',
      }}
    >
      <style>{`@keyframes eis-spin{to{transform:rotate(360deg)}}`}</style>
    </span>
  );
}
