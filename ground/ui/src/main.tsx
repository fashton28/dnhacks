import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted webfonts (offline-safe for the Electron build).
import '@fontsource-variable/geist';
import '@fontsource-variable/jetbrains-mono';
import 'leaflet/dist/leaflet.css';
import './index.css';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
