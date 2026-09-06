/* ============================================================================
 * FM-179 — the Hub fleet mapper fabricated `{lat: 0, lon: 0}` for every peer.
 *
 * `FleetVehicle.position` is what the verifier's `deconfliction` check and the
 * mission map read as a peer's true location. Zero/zero is not "unknown": it
 * is a real point in the Gulf of Guinea, and a separation check believes it.
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import type { FleetMessage } from '@/contract';
import { HubDataProvider } from '@/dataSource/HubDataProvider';
import type { FleetEntry, HubDroneState } from '@/dataSource/HubDataProvider';

const state = (overrides: Partial<HubDroneState> & { drone_id: string }): HubDroneState => ({
  lat: 41.1992364, lon: -98.3995821, alt: 40, heading_deg: 90,
  velocity_ned: { vx: 0, vy: 0, vz: 0 }, battery_pct: 88, status: 'on_mission',
  mission_id: 'm-1', gimbal_pitch_deg: 45, armed: true, mode: 'GUIDED', message: '',
  ts: new Date().toISOString(),
  ...overrides,
});

/** Drive the provider's private ingest the way its WebSocket handler does. */
function ingest(hub: HubDataProvider, states: HubDroneState[]): void {
  const inner = hub as unknown as { ingestState(s: HubDroneState): void };
  for (const s of states) inner.ingestState(s);
}

function capture(states: HubDroneState[]): { rows: FleetEntry[][]; fleet: FleetMessage[] } {
  const hub = new HubDataProvider();
  const rows: FleetEntry[][] = [];
  const fleet: FleetMessage[] = [];
  hub.onFleetRows((r) => rows.push(r));
  hub.onFleet((m) => fleet.push(m));
  ingest(hub, states);
  return { rows, fleet };
}

describe('Hub fleet → contract fleet', () => {
  it('carries the drone\'s real position instead of fabricating one', () => {
    const { fleet } = capture([state({ drone_id: 'drone-1' })]);
    const vehicle = fleet.at(-1)?.vehicles.find((v) => v.vehicleId === 'drone-1');
    expect(vehicle?.position).toEqual({ lat: 41.1992364, lon: -98.3995821, relAlt: 40 });
    expect(vehicle?.position.lat).not.toBe(0);
    expect(vehicle?.position.lon).not.toBe(0);
  });

  it('maps two drones to two distinct positions', () => {
    const { fleet } = capture([
      state({ drone_id: 'drone-1', lat: 41.1992364, lon: -98.3995821 }),
      state({ drone_id: 'drone-2', lat: 41.199461, lon: -98.3994389 }),
    ]);
    const vehicles = fleet.at(-1)?.vehicles ?? [];
    expect(vehicles).toHaveLength(2);
    expect(vehicles[0].position.lat).not.toBe(vehicles[1].position.lat);
  });

  it('OMITS a vehicle whose position the Hub has not reported', () => {
    const { fleet, rows } = capture([
      state({ drone_id: 'drone-1' }),
      state({ drone_id: 'drone-2', lat: Number.NaN, lon: Number.NaN }),
    ]);
    // Visibly missing from the contract fleet...
    expect(fleet.at(-1)?.vehicles.map((v) => v.vehicleId)).toEqual(['drone-1']);
    // ...but still selectable in the Hub-native row list.
    expect(rows.at(-1)?.map((r) => r.vehicleId)).toEqual(['drone-1', 'drone-2']);
  });

  it('never claims a sortie deadline the Hub does not report', () => {
    const { fleet } = capture([state({ drone_id: 'drone-1' })]);
    expect(fleet.at(-1)?.vehicles[0].sortie).toBeNull();
  });

  it('keeps status → controlSource and readiness mapping intact', () => {
    const { fleet } = capture([
      state({ drone_id: 'drone-1', status: 'manual_control' }),
      state({ drone_id: 'drone-2', status: 'offline' }),
      state({ drone_id: 'drone-3', status: 'idle' }),
    ]);
    const vehicles = fleet.at(-1)?.vehicles ?? [];
    expect(vehicles.find((v) => v.vehicleId === 'drone-1')?.controlSource).toBe('manual');
    expect(vehicles.find((v) => v.vehicleId === 'drone-2')?.readiness.ready).toBe(false);
    expect(vehicles.find((v) => v.vehicleId === 'drone-3')?.controlSource).toBe('auto');
  });

  it('carries the Hub mission id onto the row', () => {
    const { rows } = capture([state({ drone_id: 'drone-1', mission_id: 'm-42' })]);
    expect(rows.at(-1)?.[0].missionId).toBe('m-42');
  });
});
