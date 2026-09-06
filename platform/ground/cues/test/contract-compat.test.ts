/* Compile-time guard: every wire type this package emits must stay mutually
 * assignable with the authoritative contract. `tsc --noEmit` includes test/, so
 * drift fails typecheck; the runtime assertions below are keep-alives. */

import { describe, expect, it } from 'vitest';

import type {
  Anomaly as ContractAnomaly,
  AnomalyMessage as ContractAnomalyMessage,
  AnomalySource as ContractAnomalySource,
  CctvEventMessage as ContractCctvEventMessage,
  HealthComponent as ContractHealthComponent,
  HealthEventMessage as ContractHealthEventMessage,
} from '../../ui/src/contract/index.ts';
import { DEFAULT_VEHICLE_ID as CONTRACT_VEHICLE_ID } from '../../ui/src/contract/index.ts';

import type {
  Anomaly, AnomalyMessage, AnomalySource, CctvEventMessage,
  HealthComponent, HealthEventMessage,
} from '../src/contract.js';
import { DEFAULT_VEHICLE_ID } from '../src/contract.js';
import { RAIL_HEALTH_COMPONENT, RAIL_IDS } from '../src/types.js';

// Mutual assignability — either direction failing is a contract break.
const _anomalyOut: ContractAnomaly = {} as Anomaly;
const _anomalyIn: Anomaly = {} as ContractAnomaly;
const _messageOut: ContractAnomalyMessage = {} as AnomalyMessage;
const _messageIn: AnomalyMessage = {} as ContractAnomalyMessage;
const _healthOut: ContractHealthEventMessage = {} as HealthEventMessage;
const _healthIn: HealthEventMessage = {} as ContractHealthEventMessage;
const _cctvOut: ContractCctvEventMessage = {} as CctvEventMessage;
const _cctvIn: CctvEventMessage = {} as ContractCctvEventMessage;
const _sourceOut: ContractAnomalySource = {} as AnomalySource;
const _sourceIn: AnomalySource = {} as ContractAnomalySource;
const _componentOut: ContractHealthComponent = {} as HealthComponent;
const _componentIn: HealthComponent = {} as ContractHealthComponent;

describe('contract compatibility', () => {
  it('keeps the local wire types structurally identical to the contract', () => {
    for (const value of [
      _anomalyOut, _anomalyIn, _messageOut, _messageIn, _healthOut, _healthIn,
      _cctvOut, _cctvIn, _sourceOut, _sourceIn, _componentOut, _componentIn,
    ]) {
      expect(value).toBeDefined();
    }
  });

  it('agrees with the contract on the default vehicle id', () => {
    expect(DEFAULT_VEHICLE_ID).toBe(CONTRACT_VEHICLE_ID);
  });

  it('has one rail per contract AnomalySource, and no more', () => {
    const contractSources: ContractAnomalySource[] = [
      'sentinel2', 'sar', 'sdr', 'rf_drone', 'drone_survey', 'cctv', 'fence_sensor',
    ];
    expect([...RAIL_IDS].sort()).toEqual([...contractSources].sort());
  });

  it('maps every rail onto a published HealthComponent', () => {
    const published: ContractHealthComponent[] = [
      'link', 'planner', 'gps', 'battery', 'wind', 'camera',
      'thermal', 'lidar', 'site_model', 'mesh', 'sdr', 'envelope',
    ];
    for (const rail of RAIL_IDS) {
      expect(published).toContain(RAIL_HEALTH_COMPONENT[rail]);
    }
  });
});
