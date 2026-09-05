/**
 * settingsStore.ts — main-process key/value settings backed by
 * <userData>/settings.json.  All I/O is synchronous at read time so
 * main.ts can access defaults before the window opens, but get/set/all are
 * wrapped in promises for the IPC layer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

type SettingsMap = Record<string, unknown>;

let _cache: SettingsMap | null = null;
let _filePath: string | null = null;

function filePath(): string {
  if (_filePath) return _filePath;
  _filePath = path.join(app.getPath('userData'), 'settings.json');
  return _filePath;
}

function load(): SettingsMap {
  if (_cache) return _cache;
  const fp = filePath();
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf-8');
      _cache = JSON.parse(raw) as SettingsMap;
    } else {
      _cache = {};
    }
  } catch {
    // Corrupt settings file — start fresh
    _cache = {};
  }
  return _cache;
}

function persist(): void {
  const fp = filePath();
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(_cache, null, 2), 'utf-8');
}

export const settingsStore = {
  get<T = unknown>(key: string): Promise<T | undefined> {
    const map = load();
    return Promise.resolve(map[key] as T | undefined);
  },

  set(key: string, value: unknown): Promise<void> {
    const map = load();
    map[key] = value;
    persist();
    return Promise.resolve();
  },

  all(): Promise<SettingsMap> {
    return Promise.resolve({ ...load() });
  },
};
