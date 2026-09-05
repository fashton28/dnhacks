import * as React from 'react';

export interface TabItem {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange?: (id: string) => void;
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}

/** Segmented control / view switcher (Map ↔ Video, log severity filter…). */
export function Tabs(props: TabsProps): React.ReactElement;
