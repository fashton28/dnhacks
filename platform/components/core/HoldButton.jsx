import React from 'react';

/**
 * HoldButton — hold-to-confirm safety control for deliberate, gated actions
 * (Takeoff, Engage Tracking). The user must press and hold for `holdMs` before
 * `onConfirm` fires; releasing early cancels. Never use this to STOP something
 * (stopping must be instant — use a plain Button).
 */
export function HoldButton({
  children,
  onConfirm,
  holdMs = 1100,
  variant = 'primary',
  icon = null,
  disabled = false,
  block = true,
  hint = 'Hold to confirm',
  style = {},
}) {
  const [progress, setProgress] = React.useState(0);
  const [holding, setHolding] = React.useState(false);
  const raf = React.useRef(0);
  const start = React.useRef(0);

  const palettes = {
    primary: { base: 'var(--accent)', fill: 'var(--accent-active)', fg: '#fff', glow: 'var(--glow-accent)' },
    caution: { base: 'var(--amber-deep)', fill: 'var(--amber)', fg: '#1a1205', glow: 'var(--glow-caution)' },
    danger:  { base: 'var(--red-deep)', fill: 'var(--red)', fg: '#fff', glow: 'var(--glow-critical)' },
  };
  const p = palettes[variant] || palettes.primary;

  const stop = React.useCallback(() => {
    cancelAnimationFrame(raf.current);
    setHolding(false);
    setProgress(0);
  }, []);

  const tick = React.useCallback(() => {
    const elapsed = performance.now() - start.current;
    const pct = Math.min(1, elapsed / holdMs);
    setProgress(pct);
    if (pct >= 1) {
      setHolding(false);
      setProgress(0);
      onConfirm && onConfirm();
    } else {
      raf.current = requestAnimationFrame(tick);
    }
  }, [holdMs, onConfirm]);

  const begin = (e) => {
    if (disabled) return;
    e.preventDefault();
    setHolding(true);
    start.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  };

  React.useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={begin}
      onMouseUp={stop}
      onMouseLeave={stop}
      onTouchStart={begin}
      onTouchEnd={stop}
      style={{
        position: 'relative',
        display: block ? 'flex' : 'inline-flex',
        width: block ? '100%' : 'auto',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        height: 'var(--control-h-xl)',
        padding: '0 16px',
        background: p.base,
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 'var(--radius-md)',
        color: p.fg,
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-md)',
        fontWeight: 'var(--weight-bold)',
        letterSpacing: '0.02em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        overflow: 'hidden',
        userSelect: 'none',
        boxShadow: holding ? p.glow : 'none',
        transition: 'box-shadow var(--dur-base) var(--ease-out)',
        ...style,
      }}
    >
      {/* fill progress */}
      <span
        style={{
          position: 'absolute',
          left: 0, top: 0, bottom: 0,
          width: `${progress * 100}%`,
          background: p.fill,
          transition: holding ? 'none' : 'width var(--dur-base) var(--ease-out)',
          pointerEvents: 'none',
        }}
      />
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8, lineHeight: 1 }}>
        {icon}
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
          <span>{children}</span>
          <span style={{ fontSize: 'var(--text-2xs)', fontWeight: 'var(--weight-medium)', opacity: 0.8, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            {holding ? `${Math.round(progress * 100)}%` : hint}
          </span>
        </span>
      </span>
    </button>
  );
}
