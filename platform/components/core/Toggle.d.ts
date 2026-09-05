import * as React from 'react';

export interface ToggleProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  /** Optional trailing label (renders an inline <label>). */
  label?: React.ReactNode;
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}

/** On/off switch for settings (SITL toggle, geofence enable, map layers). */
export function Toggle(props: ToggleProps): React.ReactElement;
