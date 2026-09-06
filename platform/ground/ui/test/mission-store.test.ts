/* ============================================================================
 * FM-43 (re-planning silently keeps the stale plan and verdict) and
 * FM-42 (executePlan acks discarded; the UI reports success unconditionally).
 *
 * Both modes lived in the mission store, and both had the same shape: the UI
 * told the operator something it had not checked. Every case here fails
 * against the store as it stood before the fix.
 * ========================================================================== */
import { beforeEach, describe, expect, it } from 'vitest';
import type { MissionPlan, Verification } from '@/contract';
import { approvalPending, effectivePlan, missionStore } from '@/store/mission';

const REQUEST_ID = 'plan-task-sat-change-1';

const plan = (alt: number, requestId = REQUEST_ID): MissionPlan => ({
  requestId,
  anomalyId: 'sat-change-1',
  profile: 'inspect',
  rationale: `deterministic inspect at ${alt} m`,
  tools: [
    { tool: 'goto_gps', lat: 41.1992364, lon: -98.3995821, alt, profile: 'inspect' },
    { tool: 'rtl' },
  ],
});

const verdict = (v: Verification['verdict'], requestId = REQUEST_ID): Verification => ({
  requestId,
  verdict: v,
  checks: [{ name: 'schema', ok: v !== 'rejected', reason: v }],
});

beforeEach(() => missionStore.reset());

/* ------------------------------------------------------------------------- */
describe('FM-43 a re-plan supersedes the plan it replaces', () => {
  it('keeps the NEWER plan when the same requestId is proposed twice', () => {
    missionStore.ingestPlan(plan(30));
    missionStore.ingestPlan(plan(40));
    const proposals = missionStore.get().proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0].revision).toBe(2);
    expect(proposals[0].plan.tools[0]).toMatchObject({ tool: 'goto_gps', alt: 40 });
  });

  it('drops the stale verdict with the stale plan', () => {
    missionStore.ingestPlan(plan(30));
    missionStore.ingestVerification(verdict('pass'));
    expect(missionStore.get().proposals[0].verification?.verdict).toBe('pass');

    missionStore.ingestPlan(plan(40));
    // The verdict belonged to the plan that was replaced; keeping it would let
    // the operator approve a fresh plan against a stale pass.
    expect(missionStore.get().proposals[0].verification).toBeUndefined();

    missionStore.ingestVerification(verdict('rejected'));
    expect(missionStore.get().proposals[0].verification?.verdict).toBe('rejected');
  });

  it('sends the plan the operator is looking at, not the one it replaced', () => {
    missionStore.ingestPlan(plan(30));
    missionStore.ingestVerification(verdict('pass'));
    missionStore.ingestPlan(plan(40));
    missionStore.ingestVerification(verdict('pass'));
    const proposal = missionStore.get().proposals[0];
    expect(effectivePlan(proposal).tools[0]).toMatchObject({ alt: 40 });
  });

  it('records the supersede on the audit trail', () => {
    missionStore.ingestPlan(plan(30));
    missionStore.ingestPlan(plan(40));
    const line = missionStore.get().audit.filter((e) => e.kind === 'plan').pop();
    expect(line?.text).toContain('revision 2');
    expect(line?.text).toContain('superseded');
  });

  it('never overwrites a proposal the operator already dispatched', () => {
    missionStore.ingestPlan(plan(30));
    missionStore.ingestVerification(verdict('pass'));
    missionStore.noteApprovalSent(REQUEST_ID);
    missionStore.noteApproval(REQUEST_ID);

    missionStore.ingestPlan(plan(40));
    const proposal = missionStore.get().proposals[0];
    expect(proposal.plan.tools[0]).toMatchObject({ alt: 30 });
    expect(missionStore.get().audit.filter((e) => e.kind === 'plan').pop()?.text)
      .toContain('KEPT the plan that was sent');
  });

  it('keeps distinct requestIds as distinct proposals', () => {
    missionStore.ingestPlan(plan(30, `${REQUEST_ID}-replan-1`));
    missionStore.ingestPlan(plan(40, `${REQUEST_ID}-replan-2`));
    expect(missionStore.get().proposals).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- */
describe('FM-42 nothing is recorded as flown until the vehicle accepts it', () => {
  beforeEach(() => {
    missionStore.ingestPlan(plan(30));
    missionStore.ingestVerification(verdict('pass'));
  });

  it('a sent dispatch is pending, not approved', () => {
    missionStore.noteApprovalSent(REQUEST_ID);
    const proposal = missionStore.get().proposals[0];
    expect(approvalPending(proposal)).toBe(true);
    expect(proposal.approvedAt).toBeUndefined();
    // No mission record is opened for a mission that has not launched.
    expect(missionStore.get().records).toHaveLength(0);
    expect(missionStore.get().executedRequestId).toBeNull();
  });

  it('an ACCEPTED dispatch opens the record and closes the gate', () => {
    missionStore.noteApprovalSent(REQUEST_ID);
    missionStore.noteApproval(REQUEST_ID);
    const proposal = missionStore.get().proposals[0];
    expect(proposal.approvedAt).toBeDefined();
    expect(approvalPending(proposal)).toBe(false);
    expect(missionStore.get().executedRequestId).toBe(REQUEST_ID);
    expect(missionStore.get().records).toHaveLength(1);
  });

  it('a REFUSED dispatch opens no record and re-opens the gate', () => {
    missionStore.noteApprovalSent(REQUEST_ID);
    missionStore.noteExecuteRefused(REQUEST_ID, 'battery SoC 41% is below 80%');
    const proposal = missionStore.get().proposals[0];
    expect(proposal.approvedAt).toBeUndefined();
    expect(approvalPending(proposal)).toBe(false);
    expect(proposal.refusedReason).toContain('below 80%');
    expect(missionStore.get().records).toHaveLength(0);
    expect(missionStore.get().executedRequestId).toBeNull();
  });

  it('puts the vehicle\'s refusal reason on the audit trail', () => {
    missionStore.noteApprovalSent(REQUEST_ID);
    missionStore.noteExecuteRefused(REQUEST_ID, 'operator approval expired');
    const line = missionStore.get().audit.filter((e) => e.kind === 'denial').pop();
    expect(line?.text).toContain('REFUSED');
    expect(line?.text).toContain('operator approval expired');
    expect(line?.text).toContain('nothing was dispatched');
  });

  it('a refusal with no reason still says nothing launched', () => {
    missionStore.noteApprovalSent(REQUEST_ID);
    missionStore.noteExecuteRefused(REQUEST_ID, '');
    expect(missionStore.get().audit.filter((e) => e.kind === 'denial').pop()?.text)
      .toContain('no reason given');
  });

  it('lets the operator send again after a refusal', () => {
    missionStore.noteApprovalSent(REQUEST_ID);
    missionStore.noteExecuteRefused(REQUEST_ID, 'not ready');
    missionStore.noteApprovalSent(REQUEST_ID);
    const proposal = missionStore.get().proposals[0];
    expect(approvalPending(proposal)).toBe(true);
    expect(proposal.refusedAt).toBeUndefined();
  });

  it('clears executedRequestId if a refusal arrives for the executing plan', () => {
    missionStore.noteApprovalSent(REQUEST_ID);
    missionStore.noteApproval(REQUEST_ID);
    expect(missionStore.get().executedRequestId).toBe(REQUEST_ID);
    missionStore.noteExecuteRefused(REQUEST_ID, 'vehicle rejected mid-flight');
    expect(missionStore.get().executedRequestId).toBeNull();
  });
});
