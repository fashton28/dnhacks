/* ============================================================================
 * ARGUS Hub connection resolution.
 * ----------------------------------------------------------------------------
 * The dashboard talks to the ARGUS Hub (FastAPI, default port 8000) when:
 *   - the page URL carries `?hub=http://host:port`, or
 *   - `VITE_DATASOURCE=hub` is set at build time, or
 *   - the page is served by the Hub itself under `/gcs/`.
 * Otherwise the offline MockDataProvider stays the default.
 * ========================================================================== */
import type { ConnectionConfig } from '@/contract';

function pageParam(name: string): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(name);
}

export function servedByHub(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/gcs');
}

export function isHubMode(): boolean {
  if (pageParam('hub')) return true;
  if (import.meta.env.VITE_DATASOURCE === 'hub') return true;
  return servedByHub();
}

/** HTTP base of the Hub, no trailing slash. */
export function hubHttpBase(config?: ConnectionConfig): string {
  const fromParam = pageParam('hub');
  if (fromParam) return fromParam.replace(/\/+$/, '');
  const fromEnv = import.meta.env.VITE_HUB_URL as string | undefined;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  if (servedByHub()) return window.location.origin;
  const host = !config || config.host === 'sitl' || config.host === '' ? '127.0.0.1' : config.host;
  return `http://${host}:8000`;
}

export function hubWsBase(config?: ConnectionConfig): string {
  return hubHttpBase(config).replace(/^http/, 'ws');
}

/** Where the ARGUS Console (Three.js World view) lives, for the embedded panel. */
export function consoleUrl(config?: ConnectionConfig): string {
  return `${hubHttpBase(config)}/console/?embed=1`;
}
