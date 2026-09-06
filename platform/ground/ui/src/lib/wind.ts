/* ============================================================================
 * Wind, and where the ground station gets it (FM-72).
 *
 * `VerificationContext.windMps` is not optional in practice: `checkWind` fails
 * closed on a non-finite wind and wind has no correction rule, so a context
 * without it rejects EVERY plan — which is exactly what the live path did,
 * leaving Approve permanently disabled.
 *
 * There is no wind field on `Telemetry`. What the vehicle publishes is a
 * `healthEvent` with `component: 'wind'`, whose `detail` is a human line, so
 * the number is parsed out of it and anything unparseable is reported as
 * "no measurement" rather than guessed at.
 * ========================================================================== */
import type { HealthEventMessage } from '@/contract';

/**
 * Wind the ground station assumes until a wind report arrives, m/s.
 *
 * Deliberately the UNATTENDED envelope's own limit (`UNATTENDED_ENVELOPE
 * .maxWindMps`, half the attended 12 m/s): high enough that the wind-adjusted
 * time budget stays conservative, and the exact value at which an unattended
 * dispatch on an unmeasured wind is refused. Paired with
 * `windSource: 'assumed'`, it never authorises anything a measured wind would
 * not — see `unattendedFailures` in ground/planner/src/verifier.ts.
 */
export const ASSUMED_WIND_MPS = 6;

/**
 * Wind speed, m/s, from a `wind` health event's detail line, or undefined when
 * the line carries no speed this code is confident it understands. Only m/s is
 * accepted: converting from an assumed unit would be the same class of mistake
 * as inventing the number.
 */
export function windFromHealth(event?: HealthEventMessage): number | undefined {
  if (!event) return undefined;
  const match = /(-?\d+(?:\.\d+)?)\s*m\/s/i.exec(event.detail ?? '');
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The `windMps` + `windSource` pair a VerificationContext should carry. */
export function windContext(event?: HealthEventMessage):
{ windMps: number; windSource: 'measured' | 'assumed' } {
  const measured = windFromHealth(event);
  return measured === undefined
    ? { windMps: ASSUMED_WIND_MPS, windSource: 'assumed' }
    : { windMps: measured, windSource: 'measured' };
}
