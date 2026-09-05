import React from 'react';
import { Badge, Panel, Tabs } from '@/components';
import type { ObservationMessage, SensorHealth } from '@/contract';
import stageARgb from '../../../../site/staging/stage-a.png';
import stageAThermal from '../../../../site/staging/stage-a-thermal.png';
import stageBRgb from '../../../../site/staging/stage-b.png';
import stageBThermal from '../../../../site/staging/stage-b-thermal.png';

type FrameKind = 'rgb' | 'thermal';

const bundledFrames: Record<string, string> = {
  'stage-a.png': stageARgb,
  'stage-a-thermal.png': stageAThermal,
  'stage-b.png': stageBRgb,
  'stage-b-thermal.png': stageBThermal,
};

function bundledFrame(ref: string): string | null {
  const name = ref.replaceAll('\\', '/').split('/').pop();
  return name ? bundledFrames[name] ?? null : null;
}

function toneForHealth(state: SensorHealth): 'nominal' | 'caution' | 'danger' {
  return state === 'ok' ? 'nominal' : state === 'degraded' ? 'caution' : 'danger';
}

export interface ObservationPanelProps {
  observation: ObservationMessage | null;
  sensorHealth: Partial<Record<'rgb' | 'thermal' | 'lidar', SensorHealth>>;
}

export function ObservationPanel({ observation, sensorHealth }: ObservationPanelProps): React.ReactElement {
  const [kind, setKind] = React.useState<FrameKind>('rgb');
  const [resolved, setResolved] = React.useState<Partial<Record<FrameKind, string | null>>>({});
  // Latest health events override the observation snapshot. This prevents a
  // stale healthy frame being shown after its modality fails.
  const sensors = {
    rgb: sensorHealth.rgb ?? observation?.sensors.rgb ?? 'failed',
    thermal: sensorHealth.thermal ?? observation?.sensors.thermal ?? 'failed',
    lidar: sensorHealth.lidar ?? observation?.sensors.lidar ?? 'failed',
  };
  const rgbState = sensors.rgb;
  const thermalState = sensors.thermal;

  React.useEffect(() => {
    let cancelled = false;
    const refs = observation?.frames;
    setResolved({});
    if (!refs) return () => { cancelled = true; };
    void Promise.all((['rgb', 'thermal'] as const).map(async (modality) => {
      if ((modality === 'rgb' ? rgbState : thermalState) === 'failed') return [modality, null] as const;
      const ref = refs[modality];
      if (!ref) return [modality, null] as const;
      if (ref.startsWith('data:image/')) return [modality, ref] as const;
      const viaHost = await window.eis?.resolveSiteAsset?.(ref).catch(() => null);
      return [modality, viaHost ?? bundledFrame(ref)] as const;
    })).then((entries) => {
      if (!cancelled) setResolved(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [observation, rgbState, thermalState]);

  const healthy = sensors[kind] !== 'failed';
  const image = healthy ? resolved[kind] : null;
  const geometryCount = (observation?.geometry.fence_gaps.length ?? 0) +
    (observation?.geometry.new_structures.length ?? 0);

  return (
    <Panel
      title="Multimodal observation"
      pad={false}
      status={observation ? <Badge tone="accent" mono>{observation.scene}</Badge> : undefined}
      style={{ height: '100%' }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div style={{ padding: '8px 10px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['rgb', 'thermal', 'lidar'] as const).map((sensor) => (
          <Badge key={sensor} tone={toneForHealth(sensors[sensor])} mono>
            {sensor.toUpperCase()} {sensors[sensor]}
          </Badge>
        ))}
        <span style={{ marginLeft: 'auto', color: 'var(--text-tertiary)', fontSize: 10 }}>
          {observation?.tracks.length ?? 0} track(s) · {geometryCount} geometry claim(s)
        </span>
      </div>
      <div style={{ padding: '0 10px 8px' }}>
        <Tabs
          size="sm"
          value={kind}
          onChange={(value) => setKind(value as FrameKind)}
          items={[{ id: 'rgb', label: 'RGB' }, { id: 'thermal', label: 'Thermal' }]}
        />
      </div>
      <div style={{ flex: 1, minHeight: 120, margin: '0 10px 10px', position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-default)', background: 'var(--bg-sunken)' }}>
        {image ? (
          <img
            src={image}
            alt={`${kind} observation evidence for ${observation?.scene ?? 'mission'}`}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 16, color: healthy ? 'var(--text-disabled)' : 'var(--danger-fg)', fontSize: 12 }}>
            {observation ? healthy ? `${kind.toUpperCase()} frame unavailable` : `${kind.toUpperCase()} sensor failed — evidence withheld` : 'Awaiting observation pass'}
          </div>
        )}
        {image && observation?.tracks.map((track) => (
          <div key={track.id} style={{ position: 'absolute', left: '42%', top: '35%', width: '19%', height: '32%', border: '2px solid var(--caution-fg)', color: 'var(--caution-fg)', fontFamily: 'var(--font-mono)', fontSize: 10, padding: 3 }}>
            {track.class} {(track.conf * 100).toFixed(0)}%
          </div>
        ))}
      </div>
    </Panel>
  );
}
