import type { MissionDataSource } from './types';
import { MockDataProvider } from './MockDataProvider';
// import { LiveDataProvider } from './LiveDataProvider';
export type { MissionDataSource } from './types';
export const dataSource: MissionDataSource = new MockDataProvider();
// To go live, swap the line above for: new LiveDataProvider()
