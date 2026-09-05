import React from 'react';

/** IconButton — square icon-only control for toolbars and panel headers. */
export function IconButton({
  icon,
  size = 'md',
  variant = 'ghost',
  active = false,
  disabled = false,
  onClick,
  title,
  style = {},
  ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const dims = { sm: 26, md: 30, lg: 36 };
  const d = dims[size];

  const rest_bg = variant === 'solid' ? 'var(--surface-input)' : 'transparent';
  const bg = active ? 'var(--accent-subtle)' : hover && !disabled ? 'var(--surface-hover)' : rest_bg;
  const fg = active ? 'var(--accent-text)' : disabled ? 'var(--text-disabled)' : hover ? 'var(--text-primary)' : 'var(--text-secondary)';

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: d,
        height: d,
        flex: 'none',
        color: fg,
        background: bg,
        border: `1px solid ${active ? 'var(--accent-border)' : variant === 'solid' ? 'var(--border-input)' : 'transparent'}`,
        borderRadius: 'var(--radius-sm)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
        ...style,
      }}
      {...rest}
    >
      {icon}
    </button>
  );
}
