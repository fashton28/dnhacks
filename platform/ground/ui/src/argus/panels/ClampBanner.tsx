import React from 'react';
import { useArgus } from '../store';

/** Prominent, short-lived notice whenever the Safety Validator clamps a manual command. */
export function ClampBanner(): React.ReactElement | null {
  const clamp = useArgus((s) => s.clamp);
  const [, tick] = React.useState(0);
  React.useEffect(() => { if (!clamp) return; const id = setTimeout(() => tick((n) => n + 1), 1600); return () => clearTimeout(id); }, [clamp]);
  if (!clamp || Date.now() - clamp.ts > 1500) return null;
  return (
    <div style={{ position: 'absolute', left: '50%', top: 14, transform: 'translateX(-50%)', zIndex: 50, padding: '8px 14px', borderRadius: 8, background: 'var(--red-tint-2)', border: '1px solid var(--red-line)', color: 'var(--red-bright)', fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 700, letterSpacing: '0.06em', boxShadow: 'var(--glow-critical)' }}>
      CLAMPED · {clamp.rule.replace(/\+/g, ' + ')} — the Safety Validator stopped this command at the limit
    </div>
  );
}
