import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted webfonts (offline-safe for the Electron build).
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import 'leaflet/dist/leaflet.css';
import './index.css';
import App from './App';
import ArgusApp from './argus/ArgusApp';
import { isHubMode } from './dataSource';

/**
 * Which console this page hosts. ARGUS Hub mode — served under /gcs/, a
 * `?hub=` query, or VITE_DATASOURCE=hub — gets the ARGUS operator console;
 * every other build is the person-following ground station against the
 * offline mock (or the companion, when the build selects it).
 */
function selectConsole(): JSX.Element {
  return isHubMode() ? <ArgusApp /> : <App />;
}

function mount(): void {
  const host = document.getElementById('root');
  if (!host) {
    throw new Error('ground station: index.html has no #root mount point');
  }
  ReactDOM.createRoot(host).render(
    <React.StrictMode>{selectConsole()}</React.StrictMode>,
  );
}

mount();
