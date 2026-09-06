/* Views barrel — the modals and banners the ground station shell composes.
   `PidModal` is the name App.tsx uses for the PID tuning modal. */
export { ChecklistModal, PREFLIGHT_ITEMS } from './ChecklistModal';
export type { ChecklistModalProps } from './ChecklistModal';

export { TakeoffModal, TAKEOFF_ALT_RANGE, clampTakeoffAltitude } from './TakeoffModal';
export type { TakeoffModalProps } from './TakeoffModal';

export { SettingsModal, DEFAULT_CONTROL_PORT, parseControlPort } from './SettingsModal';
export type { SettingsModalProps } from './SettingsModal';

export { TrackingBanner } from './TrackingBanner';
export type { TrackingBannerProps } from './TrackingBanner';

export { ManualBanner } from './ManualBanner';
export type { ManualBannerProps } from './ManualBanner';

export * from './PlannerBanner';

export { FailsafeModal, FAILSAFE_RANGES, failsafeDraftWarnings } from './FailsafeModal';
export type { FailsafeModalProps } from './FailsafeModal';

export { PidTuningModal, PidTuningModal as PidModal, pidToDraft, parsePidDraft } from './PidTuningModal';
export type { PidTuningModalProps, PidDraft, PidDraftParse } from './PidTuningModal';

export { LogBrowserModal, normaliseSession, nearestFrameIndex } from './LogBrowserModal';
export type { LogBrowserModalProps } from './LogBrowserModal';

export * from './UnattendedModal';
