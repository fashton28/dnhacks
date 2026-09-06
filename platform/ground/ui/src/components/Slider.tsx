import { useId } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';

type StyleWithVars = CSSProperties & { [name: `--${string}`]: string | number };

/**
 * Slider — labelled range control for tuning values (standoff, max speed,
 * gimbal pitch). The live value is shown in tabular mono next to the label.
 *
 * The visible track, fill and thumb are drawn by CSS from two custom
 * properties this component sets on the root — `--slider-pct` for position
 * and `--slider-accent` for colour — while an invisible native
 * <input type="range"> on top provides the pointer / keyboard behaviour.
 */

export interface SliderProps {
  label?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onChange?: (v: number) => void;
  disabled?: boolean;
  accent?: string;
  ticks?: string[] | null;
  style?: CSSProperties;
}

/**
 * Where `value` sits on the track, as a percentage clamped to [0, 100].
 * A degenerate range (max <= min) or a non-finite value parks the thumb at 0
 * instead of producing NaN / Infinity in the stylesheet.
 */
export function sliderPercent(value: number, min: number, max: number): number {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(value)) return 0;
  const pct = ((value - min) / span) * 100;
  return pct < 0 ? 0 : pct > 100 ? 100 : pct;
}

export function Slider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  unit = '',
  onChange,
  disabled = false,
  accent = 'var(--accent)',
  ticks = null,
  style,
}: SliderProps) {
  const inputId = useId();
  const pct = sliderPercent(value, min, max);
  const vars: StyleWithVars = { ...style, '--slider-pct': `${pct}%`, '--slider-accent': accent };

  const emit = (e: ChangeEvent<HTMLInputElement>): void => {
    onChange?.(Number(e.target.value));
  };

  return (
    <div className="eis-slider" data-disabled={disabled || undefined} style={vars}>
      <div className="eis-slider-head">
        {label && <label htmlFor={inputId} className="eis-label">{label}</label>}
        <span className="eis-slider-value">
          <span className="eis-readout">{value}</span>
          {unit && <span className="eis-slider-unit">{unit}</span>}
        </span>
      </div>

      <div className="eis-slider-track">
        <span className="eis-slider-thumb" aria-hidden="true" />
        <input
          id={inputId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={emit}
        />
      </div>

      {ticks && (
        <div className="eis-slider-ticks">
          {ticks.map((tick, i) => <span key={i}>{tick}</span>)}
        </div>
      )}
    </div>
  );
}
