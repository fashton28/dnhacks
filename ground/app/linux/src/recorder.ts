/**
 * recorder.ts — main-process flight recorder.
 *
 * Each recording session is an NDJSON file in <userData>/recordings/ (or the
 * path from EIS_RECORDINGS_DIR).  Sessions are identified by a timestamp-based
 * UUID so they sort naturally and are unique across restarts.
 *
 * Wire protocol (called from ipc.ts):
 *   start(meta?)  → creates the file, returns { sessionId }
 *   append(frame) → synchronously appends one JSON line (fire-and-forget)
 *   stop()        → closes the session, returns { sessionId, path } | null
 *   list()        → scans the recordings dir for all sessions
 *   load(id)      → reads a session and returns { meta, frames }
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

interface SessionMeta {
  id: string;
  path: string;
  startedAt: number;
  durationMs: number;
  size: number;
}

interface ActiveSession {
  id: string;
  filePath: string;
  startedAt: number;
  meta: Record<string, unknown>;
}

let _active: ActiveSession | null = null;

function recordingsDir(): string {
  const envDir = process.env['EIS_RECORDINGS_DIR'];
  if (envDir && envDir.trim().length > 0) return envDir.trim();
  return path.join(app.getPath('userData'), 'recordings');
}

function ensureDir(): void {
  const dir = recordingsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Derive a session ID from the current timestamp (ISO-safe, filesystem-safe).
 * Format: yyyyMMdd-HHmmss-mmm  e.g. 20240622-143012-001
 */
function makeSessionId(): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return (
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}` +
    `-${pad3(now.getMilliseconds())}`
  );
}

export const recorder = {
  start(meta: Record<string, unknown> = {}): Promise<{ sessionId: string }> {
    // Stop any existing session first
    if (_active) {
      recorder.stop();
    }
    ensureDir();
    const id = makeSessionId();
    const filePath = path.join(recordingsDir(), `${id}.ndjson`);
    const startedAt = Date.now();

    // Write the header line (meta object with session id and start time)
    const header = { _header: true, id, startedAt, ...meta };
    fs.writeFileSync(filePath, JSON.stringify(header) + '\n', 'utf-8');

    _active = { id, filePath, startedAt, meta };
    return Promise.resolve({ sessionId: id });
  },

  stop(): Promise<{ sessionId: string; path: string } | null> {
    if (!_active) return Promise.resolve(null);
    const { id, filePath } = _active;
    _active = null;
    return Promise.resolve({ sessionId: id, path: filePath });
  },

  /**
   * Fire-and-forget append.  Called via ipcRenderer.send (not invoke) from the
   * preload so the renderer doesn't block waiting for an ack.  Any write error
   * is silently discarded — we prefer dropping frames over crashing.
   */
  append(frame: unknown): void {
    if (!_active) return;
    try {
      fs.appendFileSync(_active.filePath, JSON.stringify(frame) + '\n', 'utf-8');
    } catch {
      // Ignore write errors; flight data is best-effort
    }
  },

  list(): Promise<SessionMeta[]> {
    ensureDir();
    const dir = recordingsDir();
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.ndjson')).sort();
    } catch {
      return Promise.resolve([]);
    }

    const sessions: SessionMeta[] = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        // Read only the first line (header) to get metadata
        const handle = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(4096);
        const bytesRead = fs.readSync(handle, buf, 0, 4096, 0);
        fs.closeSync(handle);
        const firstLine = buf.slice(0, bytesRead).toString('utf-8').split('\n')[0];
        const header = JSON.parse(firstLine) as Record<string, unknown>;
        const id = (header['id'] as string) ?? file.replace('.ndjson', '');
        const startedAt = (header['startedAt'] as number) ?? stat.birthtimeMs;

        // Approximate duration from last write time vs start
        const durationMs = Math.max(0, stat.mtimeMs - startedAt);

        sessions.push({
          id,
          path: filePath,
          startedAt,
          durationMs,
          size: stat.size,
        });
      } catch {
        // Skip corrupt / unreadable sessions
      }
    }
    return Promise.resolve(sessions);
  },

  load(id: string): Promise<{ meta: Record<string, unknown>; frames: unknown[] } | null> {
    ensureDir();
    const filePath = path.join(recordingsDir(), `${id}.ndjson`);
    if (!fs.existsSync(filePath)) return Promise.resolve(null);

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim().length > 0);
      if (lines.length === 0) return Promise.resolve(null);

      const header = JSON.parse(lines[0]) as Record<string, unknown>;
      const meta: Record<string, unknown> = { ...header };
      delete meta['_header'];

      const frames: unknown[] = [];
      for (let i = 1; i < lines.length; i++) {
        try {
          frames.push(JSON.parse(lines[i]));
        } catch {
          // Skip malformed lines
        }
      }
      return Promise.resolve({ meta, frames });
    } catch {
      return Promise.resolve(null);
    }
  },
};
