/**
 * Escalation: the audit chain and the outbox are the product. Delivery failure
 * must never look like delivery, and nothing may block on a network.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditLog, EscalationAdapter, GENESIS_HASH, StubChannel } from '../src/escalation';

const dirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eis-escalation-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const input = {
  vehicleId: 'eis-1', missionId: 'plan-task-1', mode: 'unattended' as const,
  reason: 'unattended task refused: outside UNATTENDED_ENVELOPE',
};

describe('scripted escalation channel', () => {
  it('writes the incident to the outbox and chains the audit entry', async () => {
    const dataDir = tmpDir();
    const adapter = new EscalationAdapter({ dataDir, now: () => 1757116800000 });
    const result = await adapter.escalate(input);

    expect(result.delivered).toBe(true);
    expect(result.channel).toBe('scripted');
    expect(result.message.deliveredAt).toBe(1757116800000);
    expect(result.healthEvent).toBeUndefined();

    const outbox = fs.readdirSync(path.join(dataDir, 'outbox'));
    expect(outbox).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(dataDir, 'outbox', outbox[0]), 'utf8'));
    expect(written.type).toBe('escalation');
    expect(written.vehicleId).toBe('eis-1');
    expect(written.payload.reason).toContain('UNATTENDED_ENVELOPE');

    const entries = adapter.audit.read();
    expect(entries).toHaveLength(1);
    expect(entries[0].prev).toBe(GENESIS_HASH);
    expect(entries[0].hash).toBe(result.auditHash);
    expect(adapter.audit.verify()).toBe(-1);
  });

  it('appends, never rewrites, and detects a tampered chain', async () => {
    const dataDir = tmpDir();
    const adapter = new EscalationAdapter({ dataDir });
    await adapter.escalate(input);
    await adapter.escalate({ ...input, missionId: 'plan-task-2' });
    const entries = adapter.audit.read();
    expect(entries).toHaveLength(2);
    expect(entries[1].prev).toBe(entries[0].hash);
    expect(adapter.audit.verify()).toBe(-1);

    const file = path.join(dataDir, 'audit', 'escalations.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tampered = JSON.parse(lines[0]);
    tampered.reason = 'nothing happened';
    fs.writeFileSync(file, [JSON.stringify(tampered), lines[1]].join('\n') + '\n', 'utf8');
    expect(new AuditLog(file).verify()).toBe(0);
  });

  it('every vehicleId travels with the entry', async () => {
    const adapter = new EscalationAdapter({ dataDir: tmpDir() });
    await adapter.escalate({ ...input, vehicleId: 'eis-2' });
    expect(adapter.audit.read()[0].vehicleId).toBe('eis-2');
  });
});

describe('stub channels', () => {
  it('retries, reports undelivered, and still retains the incident', async () => {
    const dataDir = tmpDir();
    const adapter = new EscalationAdapter({ dataDir });
    const result = await adapter.escalate({ ...input, channel: 'sms' });

    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.message.deliveredAt).toBeUndefined();
    expect(result.healthEvent?.state).toBe('escalation_undelivered');
    expect(result.healthEvent?.component).toBe('planner');
    expect(result.healthEvent?.detail).toContain('retained in the outbox');
    expect(fs.existsSync(result.outboxPath as string)).toBe(true);
    expect(adapter.audit.read()[0].delivered).toBe(false);
  });

  it('never throws when a channel does', async () => {
    const exploding = {
      name: 'chat' as const, retries: 1,
      async send(): Promise<{ delivered: boolean }> { throw new Error('smtp exploded'); },
    };
    const adapter = new EscalationAdapter({ dataDir: tmpDir(), channels: { chat: exploding } });
    const result = await adapter.escalate({ ...input, channel: 'chat' });
    expect(result.delivered).toBe(false);
    expect(result.detail).toContain('smtp exploded');
    expect(result.healthEvent).toBeDefined();
  });

  it('makes no external contact from a stub', async () => {
    const stub = new StubChannel('email');
    const result = await stub.send();
    expect(result.delivered).toBe(false);
    expect(result.detail).toContain('no external contact');
  });
});
