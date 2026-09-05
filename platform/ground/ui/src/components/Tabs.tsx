import React from 'react';

/** Tabs — segmented control / view switcher. Items: [{id,label,icon?}]. */

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

export interface TabsProps {
  items?: TabItem[];
  value: string;
  onChange?: (id: string) => void;
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}

export function Tabs({ items = [], value, onChange, size = 'md', style = {} }: TabsProps) {
  const h = size === 'sm' ? 26 : 30;
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        height: h + 4,
        background: 'var(--bg-sunken)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        ...style,
      }}
    >
      {items.map((it) => {
        const on = it.id === value;
        return (
          <button
            key={it.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange && onChange(it.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: h,
              padding: '0 12px',
              borderRadius: 'var(--radius-sm)',
              border: 'none',
              background: on ? 'var(--surface-input)' : 'transparent',
              boxShadow: on ? 'var(--shadow-raised)' : 'none',
              color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-sm)',
              fontWeight: 'var(--weight-semibold)',
              letterSpacing: '0.01em',
              cursor: 'pointer',
              transition: 'color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)',
              whiteSpace: 'nowrap',
            }}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
