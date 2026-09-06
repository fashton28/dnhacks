import React from 'react';
import { X } from 'lucide-react';

/** A glass drawer over the right edge of the stage, hosting one of the dense legacy panels. */
export function Drawer({ title, icon, onClose, children }: { title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <aside className="a-glass a-drawer a-in" aria-label={title}>
      <header>
        <span style={{ color: 'var(--text-tertiary)', display: 'flex' }}>{icon}</span>
        <span className="a-label" style={{ color: 'var(--text-secondary)' }}>{title}</span>
        <span style={{ flex: 1 }} />
        <button className="a-icobtn" onClick={onClose} aria-label="Close" title="Close (Esc)"><X size={13} /></button>
      </header>
      <div className="a-drawerbody">{children}</div>
    </aside>
  );
}
