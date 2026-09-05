import React from 'react';

/** Toggle — on/off switch for settings (SITL, geofence enable, map layers). */
export function Toggle({ checked = false, onChange, disabled = false, label = null, size = 'md', style = {} }) {
  const dims = size === 'sm' ? { w: 30, h: 18, k: 12 } : { w: 38, h: 22, k: 16 };
  const sw = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange && onChange(!checked)}
      style={{
        position: 'relative',
        width: dims.w, height: dims.h, flex: 'none',
        borderRadius: 999,
        border: '1px solid',
        borderColor: checked ? 'transparent' : 'var(--border-input)',
        background: checked ? 'var(--accent)' : 'var(--surface-input)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background var(--dur-base) var(--ease-out)',
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: '50%',
          left: checked ? `calc(100% - ${dims.k}px - 2px)` : 2,
          width: dims.k, height: dims.k,
          marginTop: -dims.k / 2,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: 'var(--shadow-raised)',
          transition: 'left var(--dur-base) var(--ease-out)',
        }}
      />
    </button>
  );

  if (!label) return sw;
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 9, cursor: disabled ? 'not-allowed' : 'pointer', ...style }}>
      {sw}
      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', color: 'var(--text-secondary)' }}>{label}</span>
    </label>
  );
}
