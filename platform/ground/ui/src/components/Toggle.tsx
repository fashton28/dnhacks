import type { CSSProperties } from 'react';

/**
 * Toggle — on/off switch for settings (SITL, geofence enable, map layers,
 * demo faults). Controlled through `checked` / `onChange`.
 *
 * The switch is a `role="switch"` button; the knob position and track colour
 * follow its `aria-checked` state in CSS. With a `label` the switch is
 * wrapped in a <label> so the text is a click target too; `style` applies to
 * whichever element is outermost.
 */

export type ToggleSize = 'sm' | 'md';

export interface ToggleProps {
  checked?: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  label?: string | null;
  size?: ToggleSize;
  style?: CSSProperties;
}

export function Toggle({
  checked = false,
  onChange,
  disabled = false,
  label = null,
  size = 'md',
  style,
}: ToggleProps): JSX.Element {
  const flip = (): void => {
    if (!disabled) onChange?.(!checked);
  };

  const control = (
    <button
      type="button"
      role="switch"
      className="eis-switch"
      aria-checked={checked}
      disabled={disabled}
      data-size={size}
      style={label ? undefined : style}
      onClick={flip}
    >
      <span className="eis-switch-knob" aria-hidden="true" />
    </button>
  );

  if (!label) return control;

  return (
    <label className="eis-switch-row" data-disabled={disabled || undefined} style={style}>
      {control}
      <span className="eis-switch-text">{label}</span>
    </label>
  );
}
