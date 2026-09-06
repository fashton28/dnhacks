import { useEffect, useId } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';

type StyleWithVars = CSSProperties & { [name: `--${string}`]: string | number };

/**
 * Modal — a centred dialog over a dimmed scrim.
 *
 * Closes on Escape, on the "×", and (unless `closeOnBackdrop` is off) on a
 * press that starts on the scrim itself — a drag that ends outside the
 * dialog never dismisses it. Renders nothing at all while `open` is false, so
 * a closed modal costs no listeners. `tone` paints the accent strip and icon
 * chip; the strip is a CSS pseudo-element keyed on `data-tone`.
 */

export type ModalTone = 'default' | 'danger' | 'caution' | 'accent';

export interface ModalProps {
  open?: boolean;
  title: string;
  subtitle?: string | null;
  icon?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  tone?: ModalTone;
  closeOnBackdrop?: boolean;
}

export function Modal({
  open = true,
  title,
  subtitle = null,
  icon = null,
  onClose,
  children,
  footer = null,
  width = 460,
  tone = 'default',
  closeOnBackdrop = true,
}: ModalProps): JSX.Element | null {
  const headingId = useId();

  useEffect(() => {
    if (!open || !onClose) return undefined;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onScrimPress = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (closeOnBackdrop && onClose && e.target === e.currentTarget) onClose();
  };
  const sizing: StyleWithVars = { '--dialog-w': `${width}px` };

  return (
    <div className="eis-scrim" onMouseDown={onScrimPress}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="eis-dialog"
        data-tone={tone}
        style={sizing}
      >
        <header>
          {icon && <span className="eis-dialog-icon">{icon}</span>}
          <div className="eis-dialog-heading">
            <h2 id={headingId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {onClose && (
            <button type="button" className="eis-x" data-size="md" aria-label="Close" onClick={onClose}>
              ×
            </button>
          )}
        </header>
        <div className="eis-dialog-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}
