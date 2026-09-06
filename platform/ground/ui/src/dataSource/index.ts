import type { MissionDataSource } from './types';
import { MockDataProvider } from './MockDataProvider';
import { LiveDataProvider } from './LiveDataProvider';
import { HubDataProvider } from './HubDataProvider';
import { isHubMode } from './hubConfig';
export type { DemoScenario, FleetCapable, FleetRow, MissionDataSource } from './types';
export { fleetCapable } from './types';
export { HubDataProvider } from './HubDataProvider';
export type { FleetEntry } from './HubDataProvider';
export { isHubMode, consoleUrl, hubHttpBase } from './hubConfig';
export { LATERAL_TOL_M, ORBIT_RADIAL_TOL_M, UNATTENDED_ENVELOPE } from './scriptedRails';

type SourceKind = MissionDataSource['kind'];

/** Mock remains the zero-configuration offline default. ARGUS Hub when `?hub=`,
 * VITE_DATASOURCE=hub, or served under /gcs/. Release/demo builds select the
 * companion WebSocket provider with VITE_EIS_DATA_SOURCE=live without editing source. */
function selectSourceKind(): SourceKind {
  if (isHubMode()) return 'hub';
  return import.meta.env.VITE_EIS_DATA_SOURCE === 'live' ? 'live' : 'mock';
}

/** One constructor per provider kind; the mock also honours the night-demo flag. */
const PROVIDERS: Record<SourceKind, () => MissionDataSource> = {
  hub: () => new HubDataProvider(),
  live: () => new LiveDataProvider(),
  mock: () => {
    const mock = new MockDataProvider();
    if (import.meta.env.VITE_EIS_DEMO_NIGHT === 'true') {
      mock.setSimulationToggles({ simulateNight: true });
    }
    return mock;
  },
};

export const dataSource: MissionDataSource = PROVIDERS[selectSourceKind()]();
