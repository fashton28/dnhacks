/* ============================================================================
 * eis-cues — site normalcy: staffed hours, active gates, delivery windows.
 *
 * Normalcy suppresses cues that are explained by ordinary site activity. It is
 * a NOISE control, never an authorisation: a suppressed cue is recorded (see
 * `CueAdapter.onSuppression`) precisely because suppression is the surface an
 * insider attacks (docs/THREAT_MODEL.md A3 — widening a delivery window is an
 * attack, so every widening and every suppression must be auditable).
 *
 * GAP: docs/SITE_CONTRACT.md defines no normalcy block, so this is a
 * cues-owned config file (fixtures/normalcy.json) rather than a site field.
 * When the site contract grows one, this parser moves onto it unchanged.
 *
 * Times are wall-clock at the site. `utcOffsetMinutes` is a FIXED offset (the
 * modelled site, Komati, is SAST = UTC+120 all year); no DST table is implied.
 * ========================================================================== */

import type { WhitelistRule } from './types.js';

/** Days of the week, 0 = Sunday .. 6 = Saturday (site-local). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * A recurring site-local window. `startMinute`/`endMinute` are minutes since
 * local midnight; `endMinute <= startMinute` means the window wraps past
 * midnight (e.g. a night shift 22:00–06:00).
 */
export interface NormalcyWindow {
  days: Weekday[];
  startMinute: number;
  endMinute: number;
}

/** A camera zone, named the way a VMS event names it. */
export interface ZoneRef {
  cameraId: string;
  zone: string;
}

export interface ActiveGate extends ZoneRef {
  name: string;
  windows: NormalcyWindow[];
}

export interface DeliveryWindow {
  name: string;
  /** Unset matches any camera. */
  cameraId?: string;
  /** Unset matches any zone on the matched camera(s). */
  zone?: string;
  /** Unset matches any class. */
  classes?: string[];
  windows: NormalcyWindow[];
}

export interface SiteNormalcy {
  /** Fixed site-local offset from UTC, minutes. Komati (SAST) is +120. */
  utcOffsetMinutes: number;
  /** Hours the site is staffed. Cues in `staffedZones` are expected then. */
  staffedHours: NormalcyWindow[];
  /** Zones whose ordinary activity is explained by the site being staffed. */
  staffedZones: ZoneRef[];
  activeGates: ActiveGate[];
  deliveryWindows: DeliveryWindow[];
}

export const EMPTY_NORMALCY: SiteNormalcy = {
  utcOffsetMinutes: 0,
  staffedHours: [],
  staffedZones: [],
  activeGates: [],
  deliveryWindows: [],
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function parseWindow(v: unknown, ctx: string): NormalcyWindow {
  if (typeof v !== 'object' || v === null) throw new Error(`invalid normalcy: ${ctx} must be an object`);
  const w = v as Record<string, unknown>;
  if (!Array.isArray(w.days) || w.days.length === 0 ||
      w.days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) {
    throw new Error(`invalid normalcy: ${ctx}.days must be a non-empty array of 0..6`);
  }
  for (const key of ['startMinute', 'endMinute'] as const) {
    const value = w[key];
    if (!isFiniteNumber(value) || value < 0 || value > 1440) {
      throw new Error(`invalid normalcy: ${ctx}.${key} must be minutes in [0, 1440]`);
    }
  }
  return {
    days: [...(w.days as number[])] as Weekday[],
    startMinute: w.startMinute as number,
    endMinute: w.endMinute as number,
  };
}

function parseZoneRef(v: unknown, ctx: string): ZoneRef {
  if (typeof v !== 'object' || v === null) throw new Error(`invalid normalcy: ${ctx} must be an object`);
  const z = v as Record<string, unknown>;
  if (typeof z.cameraId !== 'string' || z.cameraId === '') {
    throw new Error(`invalid normalcy: ${ctx}.cameraId must be a non-empty string`);
  }
  if (typeof z.zone !== 'string' || z.zone === '') {
    throw new Error(`invalid normalcy: ${ctx}.zone must be a non-empty string`);
  }
  return { cameraId: z.cameraId, zone: z.zone };
}

/** Validate already-parsed normalcy JSON. Browser-safe (no file I/O). */
export function parseNormalcy(data: unknown): SiteNormalcy {
  if (typeof data !== 'object' || data === null) {
    throw new Error('invalid normalcy: root must be an object');
  }
  const d = data as Record<string, unknown>;
  if (!isFiniteNumber(d.utcOffsetMinutes) || Math.abs(d.utcOffsetMinutes) > 900) {
    throw new Error('invalid normalcy: utcOffsetMinutes must be a finite offset in minutes');
  }
  const staffedHours = Array.isArray(d.staffedHours)
    ? d.staffedHours.map((w, i) => parseWindow(w, `staffedHours[${i}]`)) : [];
  const staffedZones = Array.isArray(d.staffedZones)
    ? d.staffedZones.map((z, i) => parseZoneRef(z, `staffedZones[${i}]`)) : [];
  const activeGates = Array.isArray(d.activeGates)
    ? d.activeGates.map((g, i) => {
      const ref = parseZoneRef(g, `activeGates[${i}]`);
      const gg = g as Record<string, unknown>;
      if (typeof gg.name !== 'string' || gg.name === '') {
        throw new Error(`invalid normalcy: activeGates[${i}].name must be a non-empty string`);
      }
      if (!Array.isArray(gg.windows)) {
        throw new Error(`invalid normalcy: activeGates[${i}].windows must be an array`);
      }
      return {
        ...ref,
        name: gg.name,
        windows: gg.windows.map((w, wi) => parseWindow(w, `activeGates[${i}].windows[${wi}]`)),
      };
    }) : [];
  const deliveryWindows = Array.isArray(d.deliveryWindows)
    ? d.deliveryWindows.map((w, i) => {
      if (typeof w !== 'object' || w === null) {
        throw new Error(`invalid normalcy: deliveryWindows[${i}] must be an object`);
      }
      const ww = w as Record<string, unknown>;
      if (typeof ww.name !== 'string' || ww.name === '') {
        throw new Error(`invalid normalcy: deliveryWindows[${i}].name must be a non-empty string`);
      }
      if (!Array.isArray(ww.windows)) {
        throw new Error(`invalid normalcy: deliveryWindows[${i}].windows must be an array`);
      }
      return {
        name: ww.name,
        ...(typeof ww.cameraId === 'string' ? { cameraId: ww.cameraId } : {}),
        ...(typeof ww.zone === 'string' ? { zone: ww.zone } : {}),
        ...(Array.isArray(ww.classes) ? { classes: (ww.classes as unknown[]).map(String) } : {}),
        windows: ww.windows.map((x, wi) => parseWindow(x, `deliveryWindows[${i}].windows[${wi}]`)),
      };
    }) : [];
  return {
    utcOffsetMinutes: d.utcOffsetMinutes,
    staffedHours,
    staffedZones,
    activeGates,
    deliveryWindows,
  };
}

/** Site-local weekday and minute-of-day for an epoch-ms instant. */
export function siteLocal(tsMs: number, utcOffsetMinutes: number): { day: Weekday; minute: number } {
  const shifted = new Date(tsMs + utcOffsetMinutes * 60_000);
  return {
    day: shifted.getUTCDay() as Weekday,
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** True when `tsMs` falls inside the window (wrapping past midnight is allowed). */
export function windowContains(w: NormalcyWindow, tsMs: number, utcOffsetMinutes: number): boolean {
  const { day, minute } = siteLocal(tsMs, utcOffsetMinutes);
  const wraps = w.endMinute <= w.startMinute;
  if (!wraps) {
    return w.days.includes(day) && minute >= w.startMinute && minute < w.endMinute;
  }
  // A wrapping window belongs to the day it STARTED on.
  if (w.days.includes(day) && minute >= w.startMinute) return true;
  const previousDay = ((day + 6) % 7) as Weekday;
  return w.days.includes(previousDay) && minute < w.endMinute;
}

/** The cue a normalcy check is asked about. */
export interface NormalcyQuery {
  cameraId?: string;
  zone?: string;
  class?: string;
  tsMs: number;
}

/**
 * The first normalcy rule that explains this cue, or null.
 *
 * Only cues that name a camera AND a zone can be explained: normalcy is about
 * a known place at a known time, and an unlocated cue is never suppressed.
 */
export function normalcySuppression(n: SiteNormalcy, q: NormalcyQuery): WhitelistRule | null {
  if (!q.cameraId || !q.zone) return null;
  const offset = n.utcOffsetMinutes;

  const staffed = n.staffedZones.some((z) => z.cameraId === q.cameraId && z.zone === q.zone);
  if (staffed && n.staffedHours.some((w) => windowContains(w, q.tsMs, offset))) {
    return {
      id: `staffed_hours:${q.cameraId}/${q.zone}`,
      kind: 'staffed_hours',
      detail: `${q.zone} on ${q.cameraId} is a staffed zone and the site is staffed now`,
    };
  }

  for (const gate of n.activeGates) {
    if (gate.cameraId !== q.cameraId || gate.zone !== q.zone) continue;
    if (gate.windows.some((w) => windowContains(w, q.tsMs, offset))) {
      return {
        id: `active_gate:${gate.name}`,
        kind: 'active_gate',
        detail: `${gate.name} is an active gate in its declared window`,
      };
    }
  }

  for (const delivery of n.deliveryWindows) {
    if (delivery.cameraId !== undefined && delivery.cameraId !== q.cameraId) continue;
    if (delivery.zone !== undefined && delivery.zone !== q.zone) continue;
    if (delivery.classes !== undefined &&
        (q.class === undefined || !delivery.classes.includes(q.class))) continue;
    if (delivery.windows.some((w) => windowContains(w, q.tsMs, offset))) {
      return {
        id: `delivery_window:${delivery.name}`,
        kind: 'delivery_window',
        detail: `${delivery.name} covers ${q.zone} on ${q.cameraId} at this time`,
      };
    }
  }
  return null;
}

/** Every rule normalcy could apply, for `whitelist()`. */
export function normalcyRules(n: SiteNormalcy): WhitelistRule[] {
  const rules: WhitelistRule[] = [];
  for (const z of n.staffedZones) {
    rules.push({
      id: `staffed_hours:${z.cameraId}/${z.zone}`,
      kind: 'staffed_hours',
      detail: `${z.zone} on ${z.cameraId} is suppressed during staffed hours`,
    });
  }
  for (const gate of n.activeGates) {
    rules.push({
      id: `active_gate:${gate.name}`,
      kind: 'active_gate',
      detail: `${gate.name} (${gate.zone} on ${gate.cameraId}) is suppressed while active`,
    });
  }
  for (const delivery of n.deliveryWindows) {
    rules.push({
      id: `delivery_window:${delivery.name}`,
      kind: 'delivery_window',
      detail: `${delivery.name} suppresses ${delivery.zone ?? 'any zone'} on ` +
        `${delivery.cameraId ?? 'any camera'} in its window`,
    });
  }
  return rules;
}
