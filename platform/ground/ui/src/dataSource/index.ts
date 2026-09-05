import type { MissionDataSource } from './types';
import { MockDataProvider } from './MockDataProvider';
import { LiveDataProvider } from './LiveDataProvider';
import { HubDataProvider } from './HubDataProvider';
import { isHubMode } from './hubConfig';
export type { MissionDataSource } from './types';
export { HubDataProvider } from './HubDataProvider';
export type { FleetEntry } from './HubDataProvider';
export { isHubMode, consoleUrl, hubHttpBase } from './hubConfig';

/** Mock remains the zero-configuration offline default. ARGUS Hub when `?hub=`,
 * VITE_DATASOURCE=hub, or served under /gcs/. Release/demo builds select the
 * companion WebSocket provider with VITE_EIS_DATA_SOURCE=live without editing source. */
function createDataSource(): MissionDataSource {
  if (isHubMode()) return new HubDataProvider();
  if (import.meta.env.VITE_EIS_DATA_SOURCE === 'live') return new LiveDataProvider();
  const mock = new MockDataProvider();
  if (import.meta.env.VITE_EIS_DEMO_NIGHT === 'true') {
    mock.setSimulationToggles({ simulateNight: true });
  }
  return mock;
}

export const dataSource: MissionDataSource = createDataSource();
