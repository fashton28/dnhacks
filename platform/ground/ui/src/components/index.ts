/**
 * Design-kit primitives for the ground station. Every component's look is a
 * `.eis-*` rule in src/index.css selected by data-attributes; the modules
 * here own props, accessibility and behaviour, plus the pure helpers the
 * ui-components tests exercise (hold timing, slider maths, ...).
 */
export { Badge } from './Badge';
export type { BadgeProps, BadgeTone } from './Badge';

export { Button, buttonSize, buttonVariant } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';

export { GaugeReadout, trendGlyph } from './GaugeReadout';
export type { GaugeReadoutProps, GaugeReadoutSize, GaugeReadoutStatus, GaugeTrend } from './GaugeReadout';

export { HoldButton, DEFAULT_HOLD_MS, createHoldTimer, holdFraction } from './HoldButton';
export type { HoldButtonProps, HoldButtonVariant, HoldSnapshot, HoldTimer, HoldTimerOptions } from './HoldButton';

export { IconButton } from './IconButton';
export type { IconButtonProps, IconButtonSize, IconButtonVariant } from './IconButton';

export { Modal } from './Modal';
export type { ModalProps, ModalTone } from './Modal';

export { Panel } from './Panel';
export type { PanelProps, PanelVariant } from './Panel';

export { Slider, sliderPercent } from './Slider';
export type { SliderProps } from './Slider';

export { StatusPill } from './StatusPill';
export type { StatusPillProps, StatusPillSize, StatusPillStatus } from './StatusPill';

export { Tabs } from './Tabs';
export type { TabItem, TabsProps, TabsSize } from './Tabs';

export { Toast } from './Toast';
export type { ToastProps, ToastSeverity } from './Toast';

export { Toggle } from './Toggle';
export type { ToggleProps, ToggleSize } from './Toggle';
