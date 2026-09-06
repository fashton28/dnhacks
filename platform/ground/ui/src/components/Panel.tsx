import type { CSSProperties, ReactNode } from 'react';

/**
 * Panel — the GCS surface container: an optional header strip (uppercase
 * micro-label, optional status chip, right-aligned actions) over a body.
 *
 * The DOM is `section > header + div.eis-panel-body`; the ARGUS console
 * restyles `section > header` from argus.css, so that shape is part of the
 * contract. The header is only emitted when there is something to put in it.
 */

export type PanelVariant = 'default' | 'raised' | 'sunken' | 'flush';

export interface PanelProps {
  title?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
  pad?: boolean;
  scroll?: boolean;
  variant?: PanelVariant;
  bodyStyle?: CSSProperties;
  style?: CSSProperties;
}

export function Panel({
  title,
  icon = null,
  actions = null,
  status = null,
  children,
  pad = true,
  scroll = false,
  variant = 'default',
  bodyStyle,
  style,
}: PanelProps) {
  const headed = Boolean(title || actions || status);

  return (
    <section className="eis-panel" data-variant={variant} style={style}>
      {headed && (
        <header>
          {icon && <span className="eis-panel-icon">{icon}</span>}
          {title && <span className="eis-label">{title}</span>}
          {status && <span className="eis-panel-status">{status}</span>}
          {actions && <div className="eis-panel-actions">{actions}</div>}
        </header>
      )}
      <div
        className="eis-panel-body"
        data-pad={pad || undefined}
        data-scroll={scroll || undefined}
        style={bodyStyle}
      >
        {children}
      </div>
    </section>
  );
}
