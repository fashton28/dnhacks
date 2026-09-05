import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { app, BrowserWindow, ipcMain } from 'electron';

let plannerService: {
  propose(input: unknown): Promise<unknown>;
  report(input: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
} | null = null;
let plannerUnsubscribe: (() => void) | null = null;
let sdr: ChildProcessWithoutNullStreams | null = null;
let sdrState: { running: boolean; mode: string; vehicleId: string; pid?: number; detail?: string } = {
  running: false, mode: 'scripted', vehicleId: 'eis-1',
};

function broadcast(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(channel, payload));
}

function validSidecarEvent(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.vehicleId !== 'string' || typeof message.ts !== 'number') return false;
  if (message.type === 'spectrum') return Array.isArray(message.bands);
  if (message.type === 'rfEvent') return typeof message.kind === 'string' && typeof message.source === 'string';
  return message.type === 'healthEvent' && typeof message.component === 'string' && typeof message.state === 'string';
}

function pythonPath(root: string): string {
  if (process.env['SDR_PYTHON']) return process.env['SDR_PYTHON'];
  const bundled = process.platform === 'win32'
    ? path.join(root, 'companion', '.venv', 'Scripts', 'python.exe')
    : path.join(root, 'companion', '.venv', 'bin', 'python');
  return fs.existsSync(bundled) ? bundled : (process.platform === 'win32' ? 'python' : 'python3');
}

export function registerPhase3Handlers(root: string): void {
  const getPlanner = () => {
    if (plannerService) return plannerService;
    const modulePath = path.join(root, 'ground', 'planner', 'dist', 'index.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const planner = require(modulePath) as {
      validateSite(raw: unknown): unknown;
      PlannerService: new (site: unknown) => typeof plannerService;
    };
    const envSite = process.env['EIS_SITE_FILE'];
    const primary = envSite ? path.resolve(root, envSite) : path.join(root, 'site', 'site.json');
    const siteFile = fs.existsSync(primary) ? primary : path.join(root, 'site', 'site.stub.json');
    plannerService = new planner.PlannerService(planner.validateSite(JSON.parse(fs.readFileSync(siteFile, 'utf8'))));
    plannerUnsubscribe = plannerService?.subscribe((event) => broadcast('planner:event', event)) ?? null;
    return plannerService;
  };

  ipcMain.handle('planner:propose', (_event, input: unknown) => getPlanner()?.propose(input));
  ipcMain.handle('planner:report', (_event, input: unknown) => getPlanner()?.report(input));

  ipcMain.handle('sdr:status', () => sdrState);
  ipcMain.handle('sdr:start', (_event, input?: { mode?: string; vehicleId?: string; scenario?: string }) => {
    if (sdr) return sdrState;
    const mode = input?.mode === 'live' ? 'live' : 'scripted';
    const vehicleId = input?.vehicleId || 'eis-1';
    const scenarios = new Set(['nominal', 'floor_rise', 'narrowband', 'saturated']);
    const scenario = scenarios.has(input?.scenario ?? '') ? input?.scenario as string : 'nominal';
    const script = path.join(root, 'ground', 'sdr', 'sidecar.py');
    sdr = spawn(pythonPath(root), [script, '--mode', mode, '--vehicle-id', vehicleId, '--scenario', scenario], {
      cwd: root, env: { ...process.env, PYTHONUNBUFFERED: '1' }, windowsHide: true,
    });
    sdrState = { running: true, mode, vehicleId, pid: sdr.pid };
    createInterface({ input: sdr.stdout }).on('line', (line) => {
      try {
        const event = JSON.parse(line) as unknown;
        if (validSidecarEvent(event)) broadcast('sdr:event', event);
      } catch { /* malformed sidecar output is dropped at the trust boundary */ }
    });
    createInterface({ input: sdr.stderr }).on('line', (detail) => {
      sdrState = { ...sdrState, detail };
      broadcast('sdr:event', { type: 'healthEvent', ts: Date.now(), vehicleId,
        component: 'sdr', state: 'degraded', detail });
    });
    sdr.once('close', (code) => {
      sdr = null;
      sdrState = { running: false, mode, vehicleId, detail: `sidecar exited ${code ?? 'unknown'}` };
    });
    return sdrState;
  });
  ipcMain.handle('sdr:stop', () => {
    sdr?.kill();
    sdr = null;
    sdrState = { ...sdrState, running: false };
    return sdrState;
  });

  app.once('before-quit', () => {
    sdr?.kill();
    plannerUnsubscribe?.();
  });
}
