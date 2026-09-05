import React from 'react';

/**
 * ARGUS mark: an aperture with four rotor arms. The eye that watches the Site; the arms say "drone".
 * Drawn once here and reused for the status bar, favicon and empty states.
 */
export function ArgusMark({ size = 22, color = 'currentColor', title = 'ARGUS' }: { size?: number; color?: string; title?: string }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={title} style={{ display: 'block', flex: 'none' }}>
      {/* rotor arms */}
      <g stroke={color} strokeWidth={3} strokeLinecap="round" opacity={0.9}>
        <line x1="24" y1="3" x2="24" y2="11" />
        <line x1="24" y1="37" x2="24" y2="45" />
        <line x1="3" y1="24" x2="11" y2="24" />
        <line x1="37" y1="24" x2="45" y2="24" />
      </g>
      {/* aperture ring */}
      <circle cx="24" cy="24" r="12.5" fill="none" stroke={color} strokeWidth="3" />
      {/* iris blades */}
      <g fill={color} opacity={0.55}>
        <path d="M24 15.5 L29.5 18.6 L24 24 Z" />
        <path d="M32.5 24 L29.5 29.5 L24 24 Z" />
        <path d="M24 32.5 L18.5 29.4 L24 24 Z" />
        <path d="M15.5 24 L18.5 18.5 L24 24 Z" />
      </g>
      {/* pupil */}
      <circle cx="24" cy="24" r="3.2" fill={color} />
    </svg>
  );
}

export const ARGUS_FAVICON =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#0b0d11"/>` +
    `<g stroke="#4ee08a" stroke-width="3" stroke-linecap="round"><line x1="24" y1="4" x2="24" y2="11"/><line x1="24" y1="37" x2="24" y2="44"/><line x1="4" y1="24" x2="11" y2="24"/><line x1="37" y1="24" x2="44" y2="24"/></g>` +
    `<circle cx="24" cy="24" r="12.5" fill="none" stroke="#4ee08a" stroke-width="3"/><circle cx="24" cy="24" r="3.2" fill="#4ee08a"/></svg>`,
  );

/** Sets the document title and favicon for the ARGUS console (the HTML shell is shared with the mock app). */
export function useArgusDocument(): void {
  React.useEffect(() => {
    document.title = 'ARGUS · Meridian Station';
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.type = 'image/svg+xml';
    link.href = ARGUS_FAVICON;
  }, []);
}
