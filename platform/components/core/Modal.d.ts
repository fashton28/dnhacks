import * as React from 'react';

export interface ModalProps {
  open?: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  onClose?: () => void;
  children?: React.ReactNode;
  /** Right-aligned footer actions (Buttons). */
  footer?: React.ReactNode;
  width?: number;
  /** Accent bar + icon tint. */
  tone?: 'default' | 'danger' | 'caution' | 'accent';
  closeOnBackdrop?: boolean;
}

/**
 * Centred dialog over a scrim — Settings, Failsafe/geofence, PID tuning,
 * confirmations, and the pre-flight checklist. Esc and backdrop close.
 */
export function Modal(props: ModalProps): React.ReactElement | null;
