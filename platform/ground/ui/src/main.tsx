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

// ARGUS Hub mode (served at /gcs/, ?hub=, or VITE_DATASOURCE=hub) gets the ARGUS operator console;
// the original person-following ground station stays available against the offline mock.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isHubMode() ? <ArgusApp /> : <App />}
  </React.StrictMode>,
);
