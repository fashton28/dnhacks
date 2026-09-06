import type { CSSProperties, ReactNode } from 'react';

/**
 * Toast — one transient notification card (a command ack, an alert). The
 * owner keeps the stack and its timers; this only draws one entry, coloured
 * by `severity` through `data-severity` on `.eis-toast`.
 */

export type ToastSeverity = 'info' | 'success' | 'warning' | 'error' | 'critical';

export interface ToastProps {
  severity?: ToastSeverity;
  title: string;
  message?: string | null;
  icon?: ReactNode;
  onDismiss?: (() => void) | null;
  style?: CSSProperties;
}

export function Toast({
  severity = 'info',
  title,
  message = null,
  icon = null,
  onDismiss = null,
  style,
}: ToastProps) {
  return (
    <div role="status" className="eis-toast" data-severity={severity} style={style}>
      {icon && <span className="eis-toast-icon">{icon}</span>}
      <div className="eis-toast-body">
        <div className="eis-toast-title">{title}</div>
        {message && <div className="eis-toast-msg">{message}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="eis-x" aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}
