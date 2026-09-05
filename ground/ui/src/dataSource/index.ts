import type { DataSource } from '@/contract';
import { MockDataProvider } from './MockDataProvider';
// import { LiveDataProvider } from './LiveDataProvider';
export const dataSource: DataSource = new MockDataProvider();
// To go live, swap the line above for: new LiveDataProvider()
