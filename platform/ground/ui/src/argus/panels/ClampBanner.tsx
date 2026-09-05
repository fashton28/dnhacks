import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { useArgus } from '../store';

/** Short-lived notice whenever the Safety Validator clamps a manual command. */
export function ClampBanner(): React.ReactElement | null {
  const clamp = useArgus((s) => s.clamp);
  const [, tick] = React.useState(0);
  React.useEffect(() => { if (!clamp) return; const id = setTimeout(() => tick((n) => n + 1), 1700); return () => clearTimeout(id); }, [clamp]);
  if (!clamp || Date.now() - clamp.ts > 1600) return null;
  const rules = clamp.rule.split('+').map((r) => r.replace(/_/g, ' ')).join(', ');
  return (
    <div className="a-in" style={{ position: 'absolute', left: '50%', top: 56, transform: 'translateX(-50%)', zIndex: 50, display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderRadius: 8, background: 'rgba(240,68,56,0.16)', border: '1px solid var(--red-line)', color: 'var(--red-bright)', boxShadow: 'var(--glow-critical)', backdropFilter: 'blur(6px)' }}>
      <ShieldAlert size={16} />
      <div>
        <div style={{ font: '700 12px/1.2 var(--font-sans)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>Held at the {rules}</div>
        <div className="a-body" style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11 }}>The Safety Validator clamped your command at the limit.</div>
      </div>
    </div>
  );
}
