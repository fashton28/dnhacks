import React from 'react';
import { Badge, Button, Panel, Toggle } from '@/components';
import type { SimulationToggles } from '@/contract';
import type { DemoScenario } from '@/dataSource';

const rows: Array<[keyof SimulationToggles, string]> = [
  ['simulateGpsLoss', 'GPS loss'],
  ['simulateRfInterference', 'RF interference'],
  ['simulateHostileDrone', 'Hostile drone'],
  ['simulateLinkLoss', 'Link loss'],
  ['simulateCameraFail', 'RGB camera fail'],
  ['simulateThermalFail', 'Thermal fail'],
  ['simulateLidarFail', 'LiDAR fail'],
  ['simulateBatteryFault', 'Battery fault'],
  ['simulateCharging', 'Charging'],
  ['simulateSortieExpiry', 'Sortie expiry'],
  ['simulateNight', 'Night operation'],
];

/** Each beat is a real condition applied to the simulation — never a doctored
 *  readout. The provider decides whether the beat can run right now and says
 *  so through `hint`. */
const SCENARIOS: Array<[DemoScenario, string]> = [
  ['gust', 'Gust off corridor'],
  ['operatorAbsent', 'Operator absent'],
  ['unattendedInEnvelope', 'Unattended task · in envelope'],
  ['unattendedOutOfEnvelope', 'Unattended task · out of envelope'],
  ['handoff', 'Handoff at must_rtl_by'],
];

export interface SimulationPanelProps {
  value: SimulationToggles;
  onChange: (next: Partial<SimulationToggles>) => void;
  onScenario?: (name: DemoScenario) => void;
  hint?: (name: DemoScenario) => string;
}

export function SimulationPanel({ value, onChange, onScenario, hint }: SimulationPanelProps): React.ReactElement {
  const active = rows.filter(([key]) => value[key]).length;
  return (
    <Panel title="Demo faults" pad={false} status={<Badge tone={active ? 'caution' : 'nominal'} mono>{active} ACTIVE</Badge>}>
      <div style={{ padding: '7px 10px', display: 'grid', gap: 7 }}>
        {rows.map(([key, label]) => (
          <Toggle key={key} size="sm" checked={value[key]} label={label} onChange={(checked) => onChange({ [key]: checked } as Partial<SimulationToggles>)} style={{ justifyContent: 'space-between', flexDirection: 'row-reverse' }} />
        ))}
      </div>
      {onScenario && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '8px 10px', display: 'grid', gap: 6 }}>
          <span style={{
            fontSize: 'var(--text-2xs)', fontWeight: 600, letterSpacing: '0.07em',
            textTransform: 'uppercase', color: 'var(--text-tertiary)',
          }}>
            Authority &amp; envelope beats
          </span>
          {SCENARIOS.map(([name, label]) => (
            <Button
              key={name}
              size="sm"
              variant="secondary"
              block
              title={hint?.(name) ?? label}
              onClick={() => onScenario(name)}
              style={{ justifyContent: 'flex-start' }}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
    </Panel>
  );
}
