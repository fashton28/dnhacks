/* ============================================================================
 * Eye in the Sky — DataSourceContext
 * ----------------------------------------------------------------------------
 * Provides the single app-wide DataSource to the React tree. Mock vs Live is
 * selected in one line in dataSource/index.ts. The whole app consumes telemetry,
 * tracking, status text and commands ONLY through useDataSource().
 * ========================================================================== */
import React, { createContext, useContext } from 'react';
import type { DataSource } from '@/contract';
import { dataSource } from '@/dataSource';

const DataSourceContext = createContext<DataSource>(dataSource);

/**
 * Provides the app-wide DataSource. Per the agreed shared API this takes only
 * `children` and pulls the singleton from dataSource/index.ts. An optional
 * `source` override is accepted for tests / advanced wiring.
 */
export function DataSourceProvider(props: {
  children: React.ReactNode;
  source?: DataSource;
}): JSX.Element {
  return (
    <DataSourceContext.Provider value={props.source ?? dataSource}>
      {props.children}
    </DataSourceContext.Provider>
  );
}

export function useDataSource(): DataSource {
  return useContext(DataSourceContext);
}
