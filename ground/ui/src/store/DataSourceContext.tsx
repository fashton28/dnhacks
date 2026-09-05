/* ============================================================================
 * Eye in the Sky — DataSourceContext
 * ----------------------------------------------------------------------------
 * Provides the single app-wide DataSource to the React tree. Mock vs Live is
 * selected in one line in dataSource/index.ts. The whole app consumes telemetry,
 * tracking, status text, mission messages and commands ONLY through
 * useDataSource(). The context carries the UI-side MissionDataSource extension
 * (contract DataSource + the mission subscription channels) — the frozen
 * contract interface itself is untouched.
 * ========================================================================== */
import React, { createContext, useContext } from 'react';
import { dataSource } from '@/dataSource';
import type { MissionDataSource } from '@/dataSource';

const DataSourceContext = createContext<MissionDataSource>(dataSource);

/**
 * Provides the app-wide DataSource. Per the agreed shared API this takes only
 * `children` and pulls the singleton from dataSource/index.ts. An optional
 * `source` override is accepted for tests / advanced wiring.
 */
export function DataSourceProvider(props: {
  children: React.ReactNode;
  source?: MissionDataSource;
}): JSX.Element {
  return (
    <DataSourceContext.Provider value={props.source ?? dataSource}>
      {props.children}
    </DataSourceContext.Provider>
  );
}

export function useDataSource(): MissionDataSource {
  return useContext(DataSourceContext);
}
