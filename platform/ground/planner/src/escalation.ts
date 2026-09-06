/* ============================================================================
 * eis-planner/escalation — one interface, pluggable channels (ADR D24).
 *
 * The default and test channel is `scripted`: it appends a hash-chained audit
 * entry and writes the incident to a LOCAL OUTBOX under `data/outbox/`. Email,
 * SMS and chat exist as stubs behind the same interface so the delivery path is
 * exercised without a network dependency — nothing on the demo or test path
 * blocks on the network (ADR D4).
 *
 * Two rules this file exists to keep:
 *   1. Delivery failure never looks like delivery. Exhausted retries emit a
 *      `healthEvent` of `escalation_undelivered` and the incident stays in the
 *      outbox — it is never dropped, and never silently marked sent.
 *   2. Nothing outside the site is ever contacted automatically. The stubs do
 *      not open sockets; the destinations and timings live in docs/CONOPS.md §3.
 *
 * Every escalation in unattended mode emits an `escalation` wire message, since
 * an unattended refusal is exactly the thing a human is supposed to see.
 * ========================================================================== */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { AttendanceMode, EscalationMessage, HealthEventMessage } from './contract';

export type EscalationChannelName = 'scripted' | 'email' | 'sms' | 'chat';

export interface EscalationInput {
  vehicleId: string;
  missionId: string;
  /** Why this escalated, in one line a human can act on. */
  reason: string;
  mode: AttendanceMode;
  payload?: Record<string, unknown>;
  channel?: EscalationChannelName;
  /** Epoch ms; defaults to the adapter's clock. */
  ts?: number;
}

export interface EscalationDelivery {
  message: EscalationMessage;
  delivered: boolean;
  channel: EscalationChannelName;
  attempts: number;
  /** Absolute path of the outbox file the incident is retained in. */
  outboxPath?: string;
  /** Hash-chain head after this entry. */
  auditHash?: string;
  healthEvent?: HealthEventMessage;
  detail?: string;
}

export interface ChannelResult { delivered: boolean; detail?: string }
export interface EscalationChannel {
  readonly name: EscalationChannelName;
  readonly retries: number;
  send(message: EscalationMessage): Promise<ChannelResult>;
}

/** Where the audit chain and the outbox live, relative to the repo root. */
export const DEFAULT_DATA_DIR = 'data';
export const OUTBOX_DIR = 'outbox';
export const AUDIT_FILE = path.join('audit', 'escalations.jsonl');

/** One append-only, hash-chained audit line. */
export interface AuditEntry {
  ts: number;
  vehicleId: string;
  kind: 'escalation';
  missionId: string;
  reason: string;
  mode: AttendanceMode;
  channel: EscalationChannelName;
  delivered: boolean;
  /** Hash of the previous entry; the genesis entry chains from 64 zeros. */
  prev: string;
  /** sha256 over the entry with `hash` removed. */
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

function hashEntry(entry: Omit<AuditEntry, 'hash'>): string {
  return crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}

/** Append-only hash-chained JSONL sink. Never rewrites an existing line. */
export class AuditLog {
  constructor(readonly file: string) {}

  head(): string {
    const entries = this.read();
    return entries.length ? entries[entries.length - 1].hash : GENESIS_HASH;
  }

  read(): AuditEntry[] {
    try {
      return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch {
      return [];
    }
  }

  append(entry: Omit<AuditEntry, 'prev' | 'hash'>): AuditEntry {
    const withPrev = { ...entry, prev: this.head() };
    const complete: AuditEntry = { ...withPrev, hash: hashEntry(withPrev) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(complete)}\n`, 'utf8');
    return complete;
  }

  /** Re-walk the chain. Returns the index of the first broken link, or -1. */
  verify(): number {
    let prev = GENESIS_HASH;
    const entries = this.read();
    for (let index = 0; index < entries.length; index++) {
      const { hash, ...rest } = entries[index];
      if (rest.prev !== prev || hashEntry(rest) !== hash) return index;
      prev = hash;
    }
    return -1;
  }
}

/** The default channel: audit entry + local outbox file. Always delivers. */
export class ScriptedChannel implements EscalationChannel {
  readonly name = 'scripted' as const;
  readonly retries = 1;
  constructor(private readonly outboxDir: string) {}

  lastPath: string | undefined;

  async send(message: EscalationMessage): Promise<ChannelResult> {
    fs.mkdirSync(this.outboxDir, { recursive: true });
    const safeMission = message.missionId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(this.outboxDir, `${message.ts}-${safeMission}.json`);
    fs.writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`, 'utf8');
    this.lastPath = file;
    return { delivered: true, detail: file };
  }
}

/**
 * Email / SMS / chat: real channels in a deployment, deliberately inert here.
 * They exercise the retry-and-fail path without opening a socket.
 */
export class StubChannel implements EscalationChannel {
  constructor(readonly name: EscalationChannelName, readonly retries = 2,
    private readonly detail = 'channel is a stub in this build; no external contact is attempted') {}

  async send(): Promise<ChannelResult> {
    return { delivered: false, detail: this.detail };
  }
}

export interface EscalationAdapterOptions {
  /** Repo-root-relative or absolute; `data/` by default. */
  dataDir?: string;
  channels?: Partial<Record<EscalationChannelName, EscalationChannel>>;
  now?: () => number;
}

export class EscalationAdapter {
  readonly dataDir: string;
  readonly audit: AuditLog;
  private readonly channels: Record<EscalationChannelName, EscalationChannel>;
  private readonly now: () => number;

  constructor(options: EscalationAdapterOptions = {}) {
    this.dataDir = path.resolve(options.dataDir ?? process.env.EIS_DATA_DIR ?? DEFAULT_DATA_DIR);
    this.audit = new AuditLog(path.join(this.dataDir, AUDIT_FILE));
    this.now = options.now ?? (() => Date.now());
    this.channels = {
      scripted: new ScriptedChannel(path.join(this.dataDir, OUTBOX_DIR)),
      email: new StubChannel('email'),
      sms: new StubChannel('sms'),
      chat: new StubChannel('chat'),
      ...options.channels,
    };
  }

  /** Deliver one escalation. Never throws: a failure is a reported state. */
  async escalate(input: EscalationInput): Promise<EscalationDelivery> {
    const channelName = input.channel ?? 'scripted';
    const channel = this.channels[channelName];
    const ts = input.ts ?? this.now();
    const message: EscalationMessage = {
      type: 'escalation', ts, vehicleId: input.vehicleId, missionId: input.missionId,
      channel: channelName,
      payload: { reason: input.reason, mode: input.mode, ...(input.payload ?? {}) },
    };

    let delivered = false;
    let attempts = 0;
    let detail: string | undefined;
    const retries = Math.max(1, channel?.retries ?? 1);
    for (; attempts < retries && !delivered; attempts++) {
      try {
        const result = await channel.send(message);
        delivered = result.delivered;
        detail = result.detail;
      } catch (error) {
        detail = (error as Error).message;
      }
    }

    const entry = this.audit.append({
      ts, vehicleId: input.vehicleId, kind: 'escalation', missionId: input.missionId,
      reason: input.reason, mode: input.mode, channel: channelName, delivered,
    });

    // The incident is retained locally whatever the channel did, so an
    // undelivered escalation is still evidence rather than a lost event.
    const retained = channelName === 'scripted'
      ? (channel as ScriptedChannel).lastPath : this.retain(message);

    return {
      message: delivered ? { ...message, deliveredAt: ts } : message,
      delivered,
      channel: channelName,
      attempts,
      outboxPath: retained,
      auditHash: entry.hash,
      detail,
      ...(delivered ? {} : {
        healthEvent: {
          type: 'healthEvent', ts, vehicleId: input.vehicleId, component: 'planner',
          state: 'escalation_undelivered',
          detail: `${channelName}: ${detail ?? 'no channel acknowledgement'}; incident retained in the outbox`,
        } as HealthEventMessage,
      }),
    };
  }

  /** Write an incident to the outbox without claiming a delivery. */
  private retain(message: EscalationMessage): string {
    const dir = path.join(this.dataDir, OUTBOX_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const safeMission = message.missionId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const file = path.join(dir, `${message.ts}-${safeMission}.json`);
    fs.writeFileSync(file, `${JSON.stringify(message, null, 2)}\n`, 'utf8');
    return file;
  }
}
