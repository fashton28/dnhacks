import React from 'react';
import { Badge, Panel, Toggle } from '@/components';
import type { SimulationToggles } from '@/contract';

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

export function SimulationPanel({ value, onChange }: { value: SimulationToggles; onChange: (next: Partial<SimulationToggles>) => void }): React.ReactElement {
  const active = rows.filter(([key]) => value[key]).length;
  return (
    <Panel title="Demo faults" pad={false} status={<Badge tone={active ? 'caution' : 'nominal'} mono>{active} ACTIVE</Badge>}>
      <div style={{ padding: '7px 10px', display: 'grid', gap: 7 }}>
        {rows.map(([key, label]) => (
          <Toggle key={key} size="sm" checked={value[key]} label={label} onChange={(checked) => onChange({ [key]: checked } as Partial<SimulationToggles>)} style={{ justifyContent: 'space-between', flexDirection: 'row-reverse' }} />
        ))}
      </div>
    </Panel>
  );
}
