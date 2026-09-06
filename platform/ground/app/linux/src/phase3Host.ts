import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { app, BrowserWindow, ipcMain } from 'electron';

let plannerService: {
  propose(input: unknown): Promise<unknown>;
  report(input: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
} | null = null;
let plannerUnsubscribe: (() => void) | null = null;
let plannerLoadError: string | null = null;
let sdr: ChildProcess | null = null;
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

/** Report the SDR as unavailable on the same channel a running sidecar uses. */
function sdrUnavailable(vehicleId: string, detail: string): void {
  broadcast('sdr:event', {
    type: 'healthEvent', ts: Date.now(), vehicleId,
    component: 'sdr', state: 'no_device', detail,
  });
}

export function registerPhase3Handlers(root: string): void {
  const plannerModulePath = path.join(root, 'ground', 'planner', 'dist', 'index.js');

  const getPlanner = () => {
    if (plannerService) return plannerService;
    if (!fs.existsSync(plannerModulePath)) {
      // A missing planner bundle is a BUILD failure, not a runtime condition
      // (FM-83). Say which artefact is missing and how to produce it, instead
      // of letting `require` throw "Cannot find module <hash of a path>".
      throw new Error(
        `the ground planner is not built: ${plannerModulePath} does not exist. ` +
        'Run `npm install && npm run build` in ground/planner (scripts/setup-ground.ps1 ' +
        'and setup-ground-linux.sh both do this).');
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const planner = require(plannerModulePath) as {
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

  /**
   * Load the planner bundle NOW, off the first-proposal path (FM-82).
   *
   * `require`ing it lazily inside `planner:propose` cost a measured 3,123 ms of
   * synchronous main-process time — no IPC, no repaint, telemetry broadcast
   * stalled — at exactly the moment the demo narrative points at the planner.
   * The work is identical; it just happens while the window is still painting
   * its first frame instead of while the operator is waiting for a plan.
   *
   * A failure here is REMEMBERED, not thrown: warm-up must never stop the app
   * from starting. The first `planner:propose` retries and surfaces the real
   * reason to the operator.
   */
  const warmPlanner = (): void => {
    try {
      getPlanner();
      plannerLoadError = null;
    } catch (error) {
      plannerLoadError = (error as Error).message;
      console.error('[phase3] planner warm-up failed:', plannerLoadError);
    }
  };
  // setImmediate, not inline: the window gets to exist first.
  setImmediate(warmPlanner);

  ipcMain.handle('planner:propose', (_event, input: unknown) => getPlanner()?.propose(input));
  ipcMain.handle('planner:report', (_event, input: unknown) => getPlanner()?.report(input));
  /** Whether the planner bundle loaded, and why not when it did not. */
  ipcMain.handle('planner:status', () => ({
    ready: plannerService !== null,
    modulePath: plannerModulePath,
    error: plannerLoadError,
  }));

  ipcMain.handle('sdr:status', () => sdrState);
  ipcMain.handle('sdr:start', (_event, input?: { mode?: string; vehicleId?: string; scenario?: string }) => {
    if (sdr) return sdrState;
    const mode = input?.mode === 'live' ? 'live' : 'scripted';
    const vehicleId = input?.vehicleId || 'eis-1';
    const scenarios = new Set(['nominal', 'floor_rise', 'narrowband', 'saturated']);
    const scenario = scenarios.has(input?.scenario ?? '') ? input?.scenario as string : 'nominal';
    const script = path.join(root, 'ground', 'sdr', 'sidecar.py');

    if (!fs.existsSync(script)) {
      sdrState = { running: false, mode, vehicleId, detail: `sidecar not found at ${script}` };
      sdrUnavailable(vehicleId, sdrState.detail as string);
      return sdrState;
    }

    let child: ChildProcess;
    try {
      child = spawn(pythonPath(root), [script, '--mode', mode, '--vehicle-id', vehicleId, '--scenario', scenario], {
        cwd: root, env: { ...process.env, PYTHONUNBUFFERED: '1' }, windowsHide: true,
      });
    } catch (error) {
      // spawn can throw synchronously (EACCES, a bad cwd). The SDR is an
      // OPTIONAL sensor: it degrades to "unavailable", it never takes the
      // ground-control window down with it (FM-149).
      sdrState = { running: false, mode, vehicleId, detail: `sidecar spawn failed: ${(error as Error).message}` };
      sdrUnavailable(vehicleId, sdrState.detail as string);
      return sdrState;
    }

    sdr = child;
    sdrState = { running: true, mode, vehicleId, pid: child.pid ?? undefined };

    /**
     * The listener whose absence was the whole mode: an unhandled `error` on a
     * ChildProcess is thrown in the main process and kills the app. `pythonPath`
     * falls back to a bare `python`/`python3` that may not exist, so ENOENT here
     * is ORDINARY, and `sdr:start` fires automatically on mount.
     */
    child.on('error', (error) => {
      sdr = null;
      sdrState = { running: false, mode, vehicleId, detail: `sidecar failed to start: ${error.message}` };
      sdrUnavailable(vehicleId, sdrState.detail as string);
    });

    // A process that failed to spawn has no stdio, and `createInterface` on a
    // null stream throws just as loudly as the unhandled error did.
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const event = JSON.parse(line) as unknown;
          if (validSidecarEvent(event)) broadcast('sdr:event', event);
        } catch { /* malformed sidecar output is dropped at the trust boundary */ }
      });
    }
    if (child.stderr) {
      createInterface({ input: child.stderr }).on('line', (detail) => {
        sdrState = { ...sdrState, detail };
        broadcast('sdr:event', { type: 'healthEvent', ts: Date.now(), vehicleId,
          component: 'sdr', state: 'degraded', detail });
      });
    }

    child.once('close', (code) => {
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
