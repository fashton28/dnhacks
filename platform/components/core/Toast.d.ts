import * as React from 'react';

export interface ToastProps {
  severity?: 'info' | 'success' | 'warning' | 'error' | 'critical';
  title: React.ReactNode;
  message?: React.ReactNode;
  icon?: React.ReactNode;
  onDismiss?: () => void;
  style?: React.CSSProperties;
}

/** Transient notification — maps to CommandAck results and critical statusText. */
export function Toast(props: ToastProps): React.ReactElement;
