/* ============================================================================
 * FM-181 — the mission flow must run through the DETERMINISTIC planner and the
 * REAL verifier, not the legacy `ScriptedPlanner` path, and must surface the
 * corridor, the plan trace and the verifier's own `attended`/`deconfliction`
 * checks that those producers now emit.
 *
 * FM-180 — the cue rails must reach the `anomaly` channel through `CueBus`.
 *
 * This drives the whole offline scenario on fake timers, exactly as the demo
 * runs it, and asserts on what actually came out of the seam.
 * ========================================================================== */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnomalyMessage, HealthEventMessage, MissionPlanMessage, StatusText, VerificationMessage,
} from '@/contract';
import { CHECK_ORDER } from '@planner/verifier';
import { MockDataProvider } from '@/dataSource/MockDataProvider';
import { RAIL_PIN_COLOUR, pinColourFor } from '@/cues';

interface Seen {
  anomalies: AnomalyMessage[];
  plans: MissionPlanMessage[];
  verifications: VerificationMessage[];
  health: HealthEventMessage[];
  logs: StatusText[];
}

function subscribe(provider: MockDataProvider): Seen {
  const seen: Seen = { anomalies: [], plans: [], verifications: [], health: [], logs: [] };
  provider.onAnomaly((m) => seen.anomalies.push(m));
  provider.onMissionPlan((m) => seen.plans.push(m));
  provider.onVerification((m) => seen.verifications.push(m));
  provider.onHealthEvent((m) => seen.health.push(m));
  provider.onStatusText((m) => seen.logs.push(m));
  return seen;
}

const CONFIG = { host: 'sitl', controlPort: 8765, videoUrl: '', sitl: true };

describe('MockDataProvider mission scenario', () => {
  let provider: MockDataProvider;
  let seen: Seen;

  beforeEach(async () => {
    vi.useFakeTimers();
    provider = new MockDataProvider();
    seen = subscribe(provider);
    await provider.connect(CONFIG);
    // The five scenario beats are 5.0 / 2.5 / 2.0 / 2.5 / 2.0 s apart.
    await vi.advanceTimersByTimeAsync(30_000);
  });

  afterEach(() => {
    provider.disconnect();
    vi.useRealTimers();
  });

  it('proposes a plan and a verdict', () => {
    expect(seen.plans.length).toBeGreaterThanOrEqual(2);
    expect(seen.verifications.length).toBeGreaterThanOrEqual(2);
  });

  /* ---- FM-181 ---------------------------------------------------------- */
  it('the approvable plan comes from the deterministic planner, not ScriptedPlanner', () => {
    const plan = seen.plans.at(-1)?.plan;
    // `ScriptedPlanner` stamps `scripted-<anomalyId>`; the deterministic
    // planner derives its id from the TASK it answers.
    expect(plan?.requestId).not.toMatch(/^scripted-/);
    expect(plan?.requestId).toMatch(/^plan-task-/);
  });

  it('carries the corridor and the rule trace the planner emits', () => {
    const plan = seen.plans.at(-1)?.plan;
    expect(plan?.corridor).toBeDefined();
    expect(plan?.corridor?.legs.length).toBeGreaterThan(0);
    expect(plan?.corridor?.generated_from).toBe(plan?.requestId);
    expect(plan?.planTrace?.length).toBeGreaterThan(0);
    // A trace entry is a reason-for-record: rules and effects, no geometry.
    for (const entry of plan?.planTrace ?? []) {
      expect(typeof entry.rule).toBe('string');
      expect(typeof entry.effect).toBe('string');
    }
  });

  it('the verdict is the real verifier\'s, in its documented check order', () => {
    const verification = seen.verifications.at(-1)?.verification;
    expect(verification?.checks.map((c) => c.name)).toEqual([...CHECK_ORDER]);
    expect(verification?.checks.find((c) => c.name === 'attended')).toBeDefined();
    expect(verification?.checks.find((c) => c.name === 'deconfliction')).toBeDefined();
  });

  it('the passing plan is approvable', () => {
    const verification = seen.verifications.at(-1)?.verification;
    expect(verification?.verdict).not.toBe('rejected');
  });

  it('the deliberately-invalid demo plan still comes from the scripted rail', () => {
    // DEMO_RUNBOOK R1: the beat that shows the verifier REFUSING something.
    const failing = seen.plans.find((m) => m.plan.requestId.startsWith('scripted-failing-'));
    expect(failing).toBeDefined();
    const verdict = seen.verifications
      .find((m) => m.verification.requestId === failing?.plan.requestId)?.verification;
    expect(verdict?.verdict).toBe('rejected');
  });

  /* ---- FM-180 ---------------------------------------------------------- */
  it('cue rails reach the anomaly channel through the bus', () => {
    const sources = new Set(seen.anomalies.map((m) => m.anomaly.source));
    // The scripted scenario is the optical rail; the bus supplies the rest.
    expect(sources.has('sentinel2')).toBe(true);
    expect(sources.size).toBeGreaterThan(1);
  });

  it('publishes per-rail health for the badges', () => {
    const rails = provider.railHealth();
    expect(rails.length).toBeGreaterThan(0);
    expect(rails.map((r) => r.rail).sort())
      .toEqual(['cctv', 'drone_survey', 'fence_sensor', 'rf_drone', 'sar', 'sdr']);
    for (const rail of rails) expect(RAIL_PIN_COLOUR[rail.rail]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('every rail that raised a cue has a distinct pin colour', () => {
    const sources = [...new Set(seen.anomalies.map((m) => m.anomaly.source))];
    const colours = sources.map(pinColourFor);
    expect(new Set(colours).size).toBe(sources.length);
  });

  it('rail health reaches the wire as ordinary healthEvent messages', () => {
    // The bus adds no message type: badges ride the existing channel.
    expect(seen.health.some((m) => ['site_model', 'sdr', 'camera'].includes(m.component))).toBe(true);
  });

  it('stops the rails on disconnect', async () => {
    provider.disconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.railHealth().every((r) => r.state === 'stopped' || r.state === 'failed')).toBe(true);
  });
});
