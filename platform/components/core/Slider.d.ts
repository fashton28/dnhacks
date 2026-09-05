import * as React from 'react';

export interface SliderProps {
  label: React.ReactNode;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange?: (value: number) => void;
  disabled?: boolean;
  /** Fill/thumb colour (default accent). */
  accent?: string;
  /** Optional tick labels under the track. */
  ticks?: React.ReactNode[];
  style?: React.CSSProperties;
}

/** Labelled range control for tuning values (standoff distance, max speed). */
export function Slider(props: SliderProps): React.ReactElement;
