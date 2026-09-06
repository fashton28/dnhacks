/**
 * SignalGauge — four link-quality bars driven by RSSI, with the dBm figure and
 * round-trip latency beside them. Degrades green → amber → red as the signal
 * weakens; `lost` blanks every bar and prints LOST instead of a reading.
 */

export interface SignalGaugeProps {
  rssi?: number;
  latencyMs?: number | null;
  lost?: boolean;
  label?: string;
  compact?: boolean;
}

export type SignalStatus = 'nominal' | 'caution' | 'danger';

export interface SignalLevel {
  /** 0..1 — -100 dBm or worse is 0, -40 dBm or better is 1. */
  strength: number;
  /** Lit bars, 0..4. Never 0 while the link is up: a live link always shows at least one bar. */
  bars: number;
  status: SignalStatus;
}

export const RSSI_FLOOR_DBM = -100;
export const RSSI_CEILING_DBM = -40;
const BAR_COUNT = 4;

/** Classify a link from its RSSI (dBm) and whether it is currently lost. */
export function signalLevel(rssi: number, lost = false): SignalLevel {
  const raw = (rssi - RSSI_FLOOR_DBM) / (RSSI_CEILING_DBM - RSSI_FLOOR_DBM);
  const strength = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
  if (lost) return { strength, bars: 0, status: 'danger' };
  const bars = Math.max(1, Math.ceil(strength * BAR_COUNT));
  const status: SignalStatus = strength < 0.3 ? 'danger' : strength < 0.55 ? 'caution' : 'nominal';
  return { strength, bars, status };
}

/** "-62 dBm · 41ms" / "-62 dBm" — the text under the label while the link is up. */
export function signalReadout(rssi: number, latencyMs: number | null | undefined): string {
  const dbm = `${Math.round(rssi)} dBm`;
  return latencyMs != null ? `${dbm} · ${latencyMs}ms` : dbm;
}

export function SignalGauge({ rssi = -60, latencyMs = null, lost = false, label = 'Link', compact = false }: SignalGaugeProps) {
  const level = signalLevel(rssi, lost);
  const readout = lost ? 'LOST' : signalReadout(rssi, latencyMs);

  return (
    <div className="eis-sig" data-status={level.status} data-lost={lost || undefined} role="img" aria-label={`${label}: ${readout}`}>
      <div className="eis-sig-bars" aria-hidden="true">
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <span key={i} className="eis-sig-bar" data-on={i < level.bars || undefined} />
        ))}
      </div>
      {!compact && (
        <div className="eis-sig-text">
          <span className="eis-label">{label}</span>
          {lost
            ? <span className="eis-sig-lost">LOST</span>
            : <span className="eis-sig-read">{readout}</span>}
        </div>
      )}
    </div>
  );
}
