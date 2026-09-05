import type { MissionDataSource } from './types';
import { MockDataProvider } from './MockDataProvider';
import { HubDataProvider } from './HubDataProvider';
import { isHubMode } from './hubConfig';
// import { LiveDataProvider } from './LiveDataProvider';
export type { MissionDataSource } from './types';
export { HubDataProvider } from './HubDataProvider';
export type { FleetEntry } from './HubDataProvider';
export { isHubMode, consoleUrl, hubHttpBase } from './hubConfig';

/** Mock by default (offline demo). ARGUS Hub when `?hub=`, VITE_DATASOURCE=hub, or served under /gcs/.
 *  To go live against the companion instead, swap for: new LiveDataProvider() */
export const dataSource: MissionDataSource = isHubMode() ? new HubDataProvider() : new MockDataProvider();
