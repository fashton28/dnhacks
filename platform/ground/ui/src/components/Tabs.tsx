import type { CSSProperties, ReactNode } from 'react';

/**
 * Tabs — segmented control / view switcher. Controlled: the owner passes the
 * selected `value` and receives the next id through `onChange`. Each item is
 * a `role="tab"` button whose `aria-selected` state is what `.eis-tab` styles.
 */

export interface TabItem {
  id: string;
  label: string;
  icon?: ReactNode;
}

export type TabsSize = 'sm' | 'md';

export interface TabsProps {
  items?: TabItem[];
  value: string;
  onChange?: (id: string) => void;
  size?: TabsSize;
  style?: CSSProperties;
}

export function Tabs({ items = [], value, onChange, size = 'md', style }: TabsProps) {
  return (
    <div role="tablist" className="eis-tabs" data-size={size} style={style}>
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="eis-tab"
            aria-selected={selected}
            onClick={() => onChange?.(item.id)}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
