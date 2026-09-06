/**
 * recorder.ts — main-process flight recorder.
 *
 * ON-DISK CONTRACT (unchanged; recordings from earlier builds open as-is)
 *   directory : EIS_RECORDINGS_DIR (trimmed, when non-empty)
 *               else <userData>/recordings
 *   file      : <sessionId>.ndjson, one JSON document per line
 *   line 1    : {"_header":true,"id":"<sessionId>","startedAt":<epoch ms>,...meta}
 *   line 2..n : the frames handed to append(), verbatim JSON
 *   sessionId : local wall clock, yyyyMMdd-HHmmss-mmm (sorts chronologically)
 *
 * DESIGN
 *   `RecordingsDirectory` resolves and indexes the folder. `RecordingCodec`
 *   is the pure header/line codec (exported for the self-check). An
 *   `OpenSession` keeps ONE file descriptor open for the life of a recording
 *   and writes each frame with a single write(2) — no open/close per frame at
 *   telemetry rate — and the `FlightRecorder` facade exposes the five IPC
 *   operations. Reads never trust the file name alone: a session whose header
 *   id differs from its file name is listed and loaded by the header id.
 *
 * IPC surface (ipc.ts): recorder.start / stop / append / list / load.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface SessionMeta {
  id: string;
  path: string;
  startedAt: number;
  durationMs: number;
  size: number;
}

export interface LoadedSession {
  meta: Record<string, unknown>;
  frames: unknown[];
}

export const SESSION_FILE_EXT = '.ndjson';

/* ── Pure codec ─────────────────────────────────────────────────────────── */

const RESERVED_HEADER_KEYS = new Set(['_header', 'id', 'startedAt']);

/** Bytes we are willing to scan for the first line before giving up. */
const HEADER_SCAN_LIMIT = 64 * 1024;

/** Local-time session id layout; each token is zero-padded to its own width. */
export const SESSION_ID_PATTERN = 'yyyyMMdd-HHmmss-SSS';

export const RecordingCodec = {
  /** Session id for `at`, laid out per SESSION_ID_PATTERN (local wall clock). */
  sessionId(at: Date): string {
    const field: Record<string, number> = {
      yyyy: at.getFullYear(),
      MM: at.getMonth() + 1,
      dd: at.getDate(),
      HH: at.getHours(),
      mm: at.getMinutes(),
      ss: at.getSeconds(),
      SSS: at.getMilliseconds(),
    };
    return SESSION_ID_PATTERN.replace(/yyyy|MM|dd|HH|mm|ss|SSS/g, (token) =>
      String(field[token]).padStart(token.length, '0'),
    );
  },

  /** Header line (with newline). Reserved keys win over anything in `meta`. */
  headerLine(id: string, startedAt: number, meta: Record<string, unknown>): string {
    const header: Record<string, unknown> = { _header: true, id, startedAt };
    for (const [key, value] of Object.entries(meta)) {
      if (!RESERVED_HEADER_KEYS.has(key)) header[key] = value;
    }
    return JSON.stringify(header) + '\n';
  },

  /** Frame line (with newline), or null when the frame has no JSON form. */
  frameLine(frame: unknown): string | null {
    let text: string | undefined;
    try {
      text = JSON.stringify(frame);
    } catch {
      return null;
    }
    return typeof text === 'string' ? text + '\n' : null;
  },

  /** Parse a header line into its object, or null if it is not a header. */
  parseHeader(line: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  },

  /** Split file text into non-blank lines, tolerating CRLF. */
  lines(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.trim().length > 0) out.push(line);
    }
    return out;
  },
};

/** A session id may only ever name a file INSIDE the recordings directory. */
function isSafeSessionId(id: unknown): id is string {
  return typeof id === 'string'
    && id.length > 0
    && id !== '.' && id !== '..'
    && !/[\\/\0]/.test(id);
}

/* ── Directory ──────────────────────────────────────────────────────────── */

interface IndexedFile {
  file: string;
  filePath: string;
  header: Record<string, unknown> | null;
  stat: fs.Stats;
}

class RecordingsDirectory {
  constructor(private readonly fallback: () => string) {}

  /** Resolved on every call so an env change is honoured without a restart. */
  get dirPath(): string {
    const override = process.env['EIS_RECORDINGS_DIR']?.trim();
    return override ? override : this.fallback();
  }

  ensure(): string {
    const dir = this.dirPath;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  fileFor(id: string): string {
    return path.join(this.dirPath, id + SESSION_FILE_EXT);
  }

  /**
   * Read just the first line of a file, 4 KiB at a time, up to
   * HEADER_SCAN_LIMIT. A header longer than one chunk (a large meta object)
   * is still found; an empty file yields null.
   */
  private static headLine(filePath: string): string | null {
    const fd = fs.openSync(filePath, 'r');
    try {
      const chunks: Buffer[] = [];
      let scanned = 0;
      while (scanned < HEADER_SCAN_LIMIT) {
        const chunk = Buffer.alloc(4096);
        const n = fs.readSync(fd, chunk, 0, chunk.length, scanned);
        if (n === 0) break;
        const newline = chunk.indexOf(0x0a);
        if (newline >= 0 && newline < n) {
          chunks.push(chunk.subarray(0, newline));
          return Buffer.concat(chunks).toString('utf-8');
        }
        chunks.push(chunk.subarray(0, n));
        scanned += n;
      }
      return scanned > 0 && scanned < HEADER_SCAN_LIMIT
        ? Buffer.concat(chunks).toString('utf-8')
        : null;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Every *.ndjson file, name-sorted, with its header when readable. */
  index(): IndexedFile[] {
    const dir = this.ensure();
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith(SESSION_FILE_EXT)).sort();
    } catch {
      return [];
    }
    const out: IndexedFile[] = [];
    for (const file of names) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        const line = RecordingsDirectory.headLine(filePath);
        const header = line === null ? null : RecordingCodec.parseHeader(line.replace(/\r$/, ''));
        out.push({ file, filePath, header, stat });
      } catch {
        /* unreadable entry: leave it out of the index */
      }
    }
    return out;
  }
}

/** Metadata for one indexed file, or null if its header does not parse. */
function describe(entry: IndexedFile): SessionMeta | null {
  if (entry.header === null) return null;
  const id = typeof entry.header['id'] === 'string'
    ? entry.header['id']
    : entry.file.slice(0, -SESSION_FILE_EXT.length);
  const declaredStart = entry.header['startedAt'];
  const startedAt = typeof declaredStart === 'number' && Number.isFinite(declaredStart)
    ? declaredStart
    : entry.stat.birthtimeMs;
  return {
    id,
    path: entry.filePath,
    startedAt,
    durationMs: Math.max(0, entry.stat.mtimeMs - startedAt),
    size: entry.stat.size,
  };
}

/* ── Live session ───────────────────────────────────────────────────────── */

class OpenSession {
  private fd: number | null;
  frames = 0;
  dropped = 0;

  constructor(
    readonly id: string,
    readonly filePath: string,
    readonly startedAt: number,
    meta: Record<string, unknown>,
  ) {
    this.fd = fs.openSync(filePath, 'w');
    fs.writeSync(this.fd, RecordingCodec.headerLine(id, startedAt, meta));
  }

  /** Best effort: a frame that cannot be written is dropped, never thrown. */
  write(frame: unknown): void {
    if (this.fd === null) return;
    const line = RecordingCodec.frameLine(frame);
    if (line === null) {
      this.dropped += 1;
      return;
    }
    try {
      fs.writeSync(this.fd, line);
      this.frames += 1;
    } catch {
      this.dropped += 1;
    }
  }

  close(): void {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      fs.closeSync(fd);
    } catch {
      /* the data already written is on disk; nothing more to do */
    }
  }
}

/* ── Facade ─────────────────────────────────────────────────────────────── */

export interface FlightRecorder {
  start(meta?: Record<string, unknown>): Promise<{ sessionId: string }>;
  stop(): Promise<{ sessionId: string; path: string } | null>;
  append(frame: unknown): void;
  list(): Promise<SessionMeta[]>;
  load(id: string): Promise<LoadedSession | null>;
  /** Id of the session currently being written, or null. */
  activeSessionId(): string | null;
}

export function createRecorder(fallbackDir: () => string): FlightRecorder {
  const directory = new RecordingsDirectory(fallbackDir);
  let session: OpenSession | null = null;

  const closeActive = (): { sessionId: string; path: string } | null => {
    if (!session) return null;
    const { id, filePath } = session;
    session.close();
    session = null;
    return { sessionId: id, path: filePath };
  };

  /** A fresh id; on the (clock-reset) chance the file exists, suffix it. */
  const allocateId = (): string => {
    const base = RecordingCodec.sessionId(new Date());
    let candidate = base;
    for (let n = 1; fs.existsSync(directory.fileFor(candidate)); n += 1) {
      candidate = `${base}-${n}`;
    }
    return candidate;
  };

  const locate = (id: string): string | null => {
    if (!isSafeSessionId(id)) return null;
    const direct = directory.fileFor(id);
    if (fs.existsSync(direct)) return direct;
    const byHeader = directory.index().find((entry) => entry.header?.['id'] === id);
    return byHeader ? byHeader.filePath : null;
  };

  return {
    start(meta: Record<string, unknown> = {}): Promise<{ sessionId: string }> {
      closeActive();
      directory.ensure();
      const id = allocateId();
      session = new OpenSession(id, directory.fileFor(id), Date.now(), meta ?? {});
      return Promise.resolve({ sessionId: id });
    },

    stop(): Promise<{ sessionId: string; path: string } | null> {
      return Promise.resolve(closeActive());
    },

    append(frame: unknown): void {
      session?.write(frame);
    },

    list(): Promise<SessionMeta[]> {
      const sessions: SessionMeta[] = [];
      for (const entry of directory.index()) {
        const meta = describe(entry);
        if (meta) sessions.push(meta);
      }
      return Promise.resolve(sessions);
    },

    load(id: string): Promise<LoadedSession | null> {
      const filePath = locate(id);
      if (filePath === null) return Promise.resolve(null);

      let lines: string[];
      try {
        lines = RecordingCodec.lines(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        return Promise.resolve(null);
      }
      if (lines.length === 0) return Promise.resolve(null);

      const header = RecordingCodec.parseHeader(lines[0]);
      if (header === null) return Promise.resolve(null);
      const meta: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(header)) if (key !== '_header') meta[key] = value;

      const frames: unknown[] = [];
      for (const line of lines.slice(1)) {
        try {
          frames.push(JSON.parse(line));
        } catch {
          /* a torn or foreign line is skipped, the rest of the flight still loads */
        }
      }
      return Promise.resolve({ meta, frames });
    },

    activeSessionId(): string | null {
      return session?.id ?? null;
    },
  };
}

/** The process-wide recorder the IPC handlers use. */
export const recorder: FlightRecorder = createRecorder(() =>
  path.join(app.getPath('userData'), 'recordings'),
);
