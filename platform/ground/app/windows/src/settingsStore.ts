/**
 * settingsStore.ts — main-process settings persistence.
 *
 * ON-DISK CONTRACT (unchanged; files written by earlier builds load as-is)
 *   location : <userData>/settings.json
 *   layout   : one JSON object; each top-level key is a setting name the
 *              renderer chose (today only "eis.settings"), each value any JSON
 *   encoding : UTF-8, JSON.stringify(..., null, 2) — two-space indentation
 *
 * DESIGN
 *   Two layers. `JsonDocumentFile` is the persistence layer: it locates the
 *   file, decodes it against the schema above (repairing or quarantining what
 *   does not fit), and replaces it atomically (write a sibling temp file, then
 *   rename over the target) so a crash mid-write can never leave a truncated
 *   settings.json behind. `SettingsStore` sits on top: it owns the in-memory
 *   entries (a Map, never a prototype-bearing object, so a hostile key such as
 *   "__proto__" cannot pollute anything) and pushes every operation through one
 *   serial queue, which gives the IPC layer read-your-writes ordering and makes
 *   each set() resolve only once its bytes are on disk.
 *
 * IPC surface (ipc.ts): settingsStore.get / set / all — all promise-returning.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export type SettingsEntries = Record<string, unknown>;

/** The one layout this build reads and writes. */
export const SETTINGS_SCHEMA = Object.freeze({
  fileName: 'settings.json',
  /** JSON indentation used when encoding (part of the on-disk contract). */
  indent: 2,
  /** Where an unreadable file is parked so its bytes survive the first write. */
  quarantineSuffix: '.corrupt',
  /** Keys that must never become own properties of a merged settings object. */
  forbiddenKeys: ['__proto__', 'constructor', 'prototype'] as readonly string[],
});

/** What decoding a settings file produced, and why. */
export type SettingsDecodeOutcome =
  | { kind: 'loaded'; entries: SettingsEntries }
  | { kind: 'empty' }
  | { kind: 'repaired'; entries: SettingsEntries; reason: string }
  | { kind: 'corrupt'; reason: string };

/**
 * Decode the text of a settings file. Pure; exported for the self-check.
 *
 *   ""/whitespace            → empty
 *   valid flat object        → loaded
 *   object with bad keys     → repaired (forbidden keys dropped)
 *   array / scalar / null    → repaired (nothing to keep; start empty)
 *   unparsable JSON          → corrupt
 */
export function decodeSettingsDocument(text: string): SettingsDecodeOutcome {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim().length === 0) return { kind: 'empty' };

  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch (err) {
    return { kind: 'corrupt', reason: `not JSON: ${(err as Error).message}` };
  }

  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return {
      kind: 'repaired',
      entries: {},
      reason: `root is ${Array.isArray(root) ? 'an array' : root === null ? 'null' : typeof root}, expected an object`,
    };
  }

  const entries: SettingsEntries = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    if (SETTINGS_SCHEMA.forbiddenKeys.includes(key)) dropped.push(key);
    else entries[key] = value;
  }
  return dropped.length === 0
    ? { kind: 'loaded', entries }
    : { kind: 'repaired', entries, reason: `dropped forbidden keys: ${dropped.join(', ')}` };
}

/** Encode entries in the exact layout earlier builds wrote. Pure. */
export function encodeSettingsDocument(entries: SettingsEntries): string {
  return JSON.stringify(entries, null, SETTINGS_SCHEMA.indent);
}

/* ────────────────────────────────────────────────────────────────────────── */

/** Persistence layer: one JSON document at a lazily located path. */
class JsonDocumentFile {
  private located: string | null = null;

  constructor(private readonly locate: () => string) {}

  get filePath(): string {
    if (this.located === null) this.located = this.locate();
    return this.located;
  }

  async read(): Promise<SettingsDecodeOutcome> {
    let text: string;
    try {
      text = await fs.promises.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'empty' };
      return { kind: 'corrupt', reason: `unreadable: ${(err as Error).message}` };
    }
    const outcome = decodeSettingsDocument(text);
    if (outcome.kind === 'corrupt') await this.quarantine();
    return outcome;
  }

  /** Keep the unreadable bytes next to the file we are about to replace. Best effort. */
  private async quarantine(): Promise<void> {
    try {
      await fs.promises.copyFile(this.filePath, this.filePath + SETTINGS_SCHEMA.quarantineSuffix);
    } catch {
      /* the original stays where it is until the first successful write */
    }
  }

  /** Atomic replace: temp sibling + rename, with a plain overwrite as the fallback. */
  async write(entries: SettingsEntries): Promise<void> {
    const target = this.filePath;
    const text = encodeSettingsDocument(entries);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });

    const temp = `${target}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(temp, text, 'utf-8');
      await fs.promises.rename(temp, target);
    } catch {
      await fs.promises.rm(temp, { force: true }).catch(() => undefined);
      await fs.promises.writeFile(target, text, 'utf-8');
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */

export interface SettingsStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  all(): Promise<SettingsEntries>;
  /** Absolute path of the backing file (diagnostics). */
  readonly filePath: string;
}

/**
 * Build a store over `locate()`. The document is read once, on first use;
 * every operation is queued behind the previous one so writes never
 * interleave and a get() issued after a set() observes that set().
 */
export function createSettingsStore(locate: () => string): SettingsStore {
  const file = new JsonDocumentFile(locate);
  let entries: Map<string, unknown> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const serial = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op);
    queue = next.catch(() => undefined);
    return next;
  };

  const open = async (): Promise<Map<string, unknown>> => {
    if (entries) return entries;
    const outcome = await file.read();
    switch (outcome.kind) {
      case 'loaded':
        entries = new Map(Object.entries(outcome.entries));
        break;
      case 'repaired':
        console.warn(`[settings] ${file.filePath}: ${outcome.reason}; repaired`);
        entries = new Map(Object.entries(outcome.entries));
        break;
      case 'corrupt':
        console.error(`[settings] ${file.filePath}: ${outcome.reason}; starting fresh (copy kept as *${SETTINGS_SCHEMA.quarantineSuffix})`);
        entries = new Map();
        break;
      default:
        entries = new Map();
    }
    return entries;
  };

  const materialize = (map: Map<string, unknown>): SettingsEntries => {
    const out: SettingsEntries = {};
    for (const [key, value] of map) if (value !== undefined) out[key] = value;
    return out;
  };

  return {
    get filePath() {
      return file.filePath;
    },
    get<T = unknown>(key: string): Promise<T | undefined> {
      return serial(async () => (await open()).get(key) as T | undefined);
    },
    set(key: string, value: unknown): Promise<void> {
      return serial(async () => {
        const map = await open();
        if (value === undefined) map.delete(key);
        else map.set(key, value);
        await file.write(materialize(map));
      });
    },
    all(): Promise<SettingsEntries> {
      return serial(async () => materialize(await open()));
    },
  };
}

/** The process-wide store the IPC handlers use: <userData>/settings.json. */
export const settingsStore: SettingsStore = createSettingsStore(() =>
  path.join(app.getPath('userData'), SETTINGS_SCHEMA.fileName),
);
