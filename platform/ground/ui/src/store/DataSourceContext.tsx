/* ============================================================================
 * Drone Safety Platform — DataSourceContext
 * ----------------------------------------------------------------------------
 * Hands the app-wide DataSource to the React tree. Mock vs Live vs Hub is
 * decided once in dataSource/index.ts; nothing under the provider knows which
 * one it got. Telemetry, tracking, status text, mission channels and commands
 * all flow through useDataSource() — the UI-side MissionDataSource extension
 * of the frozen contract DataSource.
 *
 * The context's own default is deliberately `null`: the hook, not the
 * context, falls back to the singleton. That keeps a tree rendered without a
 * provider (tests, storybook-style harnesses) working while making "provided"
 * and "defaulted" distinguishable inside the hook.
 * ========================================================================== */
import React, { createContext, useContext } from 'react';
import { dataSource as appDataSource } from '@/dataSource';
import type { MissionDataSource } from '@/dataSource';

const DataSourceContext = createContext<MissionDataSource | null>(null);
DataSourceContext.displayName = 'DataSourceContext';

export interface DataSourceProviderProps {
  children: React.ReactNode;
  /** Override for tests / advanced wiring; the singleton otherwise. */
  source?: MissionDataSource;
}

/** Provides the app-wide DataSource. Takes only `children` in normal use. */
export function DataSourceProvider({ children, source }: DataSourceProviderProps): JSX.Element {
  return React.createElement(DataSourceContext.Provider, { value: source ?? appDataSource }, children);
}

/** The DataSource in scope — the provided one, else the app singleton. */
export function useDataSource(): MissionDataSource {
  return useContext(DataSourceContext) ?? appDataSource;
}
