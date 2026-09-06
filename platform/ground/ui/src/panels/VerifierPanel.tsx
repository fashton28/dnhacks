/* VerifierPanel — mission plans and their deterministic MissionVerifier
   outcomes. Shows the proposal history (verdict chips), the selected plan's
   tool list + rationale, every VerificationCheck row (ok icon, reason,
   applied edit), an original-vs-corrected diff when the verifier repaired the
   plan, and the operator gate: hold-to-approve (sends executePlan with the
   EFFECTIVE plan — corrected when present) or deny. */
import React from 'react';
import { Check, Clock, X, ShieldCheck, ShieldAlert, ShieldX } from 'lucide-react';
import { Panel, Badge, Button, HoldButton } from '@/components';
import type { MissionPlan, PlanTool, Verification } from '@/contract';
import type { PlanProposal } from '@/store';
import { approvalPending, effectivePlan } from '@/store';

export interface VerifierPanelProps {
  proposals: PlanProposal[];
  selectedRequestId: string | null;
  executing: boolean;
  onSelect: (requestId: string) => void;
  onApprove: (proposal: PlanProposal) => void;
  onDeny: (proposal: PlanProposal) => void;
  readinessReady?: boolean;
  readinessReasons?: string[];
}

const VERDICT_TONE: Record<Verification['verdict'], 'nominal' | 'caution' | 'danger'> = {
  pass: 'nominal',
  corrected: 'caution',
  rejected: 'danger',
};

function describeTool(t: PlanTool): string {
  switch (t.tool) {
    case 'follow':
      return `follow track ${t.track_id} [${t.profile}]`;
    case 'orbit':
      return `orbit track ${t.track_id} [${t.profile}]`;
    case 'goto_relative':
      return `relative ${t.dx}, ${t.dy}, ${t.dz} m`;
    case 'goto_gps':
      return `goto ${t.lat.toFixed(5)}, ${t.lon.toFixed(5)} @ ${t.alt} m` + (t.profile ? ` [${t.profile}]` : '');
    case 'orbit_point':
      return `orbit ${t.lat.toFixed(5)}, ${t.lon.toFixed(5)} r=${t.radius} m`;
    case 'hold':
      return t.durationS !== undefined ? `hold ${t.durationS} s` : 'hold (indefinite)';
    case 'rtl':
      return 'return to launch';
  }
}

/** Human diff of one tool between original and corrected plan ('' = same). */
function toolDiff(a: PlanTool, b: PlanTool): string {
  if (a.tool !== b.tool) return `${a.tool} → ${b.tool}`;
  const parts: string[] = [];
  if (a.tool === 'goto_gps' && b.tool === 'goto_gps') {
    if (a.alt !== b.alt) parts.push(`alt ${a.alt} → ${b.alt} m`);
    if (a.lat !== b.lat || a.lon !== b.lon) {
      parts.push(`pos ${a.lat.toFixed(5)},${a.lon.toFixed(5)} → ${b.lat.toFixed(5)},${b.lon.toFixed(5)}`);
    }
  }
  if (a.tool === 'orbit_point' && b.tool === 'orbit_point') {
    if (a.lat !== b.lat || a.lon !== b.lon) {
      parts.push(`centre ${a.lat.toFixed(5)},${a.lon.toFixed(5)} → ${b.lat.toFixed(5)},${b.lon.toFixed(5)}`);
    }
    if (a.radius !== b.radius) parts.push(`radius ${a.radius} → ${b.radius} m`);
  }
  return parts.join('; ');
}

export function VerifierPanel({
  proposals,
  selectedRequestId,
  executing,
  onSelect,
  onApprove,
  onDeny,
  readinessReady = false,
  readinessReasons = ['readiness unavailable'],
}: VerifierPanelProps): React.ReactElement {
  const selected =
    proposals.find((p) => p.plan.requestId === selectedRequestId) ??
    proposals[proposals.length - 1];

  const v = selected?.verification;

  /* A delayed-dispatch correction: the plan is fine, but it must not be
     dispatched before `holdUntil` (an attended window that has not opened, a
     deconfliction wait). The gate re-opens on its own when the clock passes. */
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const holdUntil = v?.holdUntil;
  React.useEffect(() => {
    if (!holdUntil || holdUntil <= Date.now()) return;
    const id = setInterval(() => setNowMs(Date.now()), 500);
    return () => clearInterval(id);
  }, [holdUntil]);
  const holdLeftS = holdUntil && holdUntil > nowMs ? Math.ceil((holdUntil - nowMs) / 1000) : 0;

  /* A dispatch the vehicle has not answered yet is neither approved nor
     refused: the gate stays shut while the ack is outstanding, and re-opens if
     the vehicle refuses, so the operator can fix the cause and try again
     (FM-42). */
  const pending = !!selected && approvalPending(selected);
  const approvable =
    !!selected && !!v && (v.verdict === 'pass' || v.verdict === 'corrected') &&
    !selected.approvedAt && !selected.deniedAt && !pending && !executing && readinessReady &&
    holdLeftS === 0;

  return (
    <Panel
      title="Mission verifier"
      pad={false}
      status={
        v ? <Badge tone={VERDICT_TONE[v.verdict]} mono>{v.verdict.toUpperCase()}</Badge>
          : selected ? <Badge tone="outline" mono>VERIFYING…</Badge>
          : undefined
      }
      style={{ height: '100%' }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {proposals.length === 0 ? (
        <div style={{ padding: 14, color: 'var(--text-disabled)', fontSize: 'var(--text-sm)' }}>
          No mission plans yet — waiting for the planner.
        </div>
      ) : (
        <>
          {/* proposal chips */}
          <div style={{ display: 'flex', gap: 6, padding: '8px 10px', flexWrap: 'wrap', flex: 'none' }}>
            {proposals.map((p) => {
              const on = p.plan.requestId === selected?.plan.requestId;
              const tone = p.verification ? VERDICT_TONE[p.verification.verdict] : 'outline';
              return (
                <button
                  key={p.plan.requestId}
                  onClick={() => onSelect(p.plan.requestId)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '3px 8px',
                    background: on ? 'var(--surface-input)' : 'transparent',
                    border: `1px solid ${on ? 'var(--border-strong)' : 'var(--border-subtle)'}`,
                    borderRadius: 'var(--radius-pill)',
                    color: 'var(--text-secondary)',
                    fontFamily: 'var(--font-mono)', fontSize: 10, cursor: 'pointer',
                  }}
                >
                  {p.plan.requestId}
                  <Badge tone={tone as 'nominal' | 'caution' | 'danger' | 'outline'} mono>
                    {p.verification ? p.verification.verdict : '…'}
                  </Badge>
                </button>
              );
            })}
          </div>

          {/* selected proposal detail */}
          {selected && (
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 12px 10px' }}>
              <SectionLabel>Plan · profile {selected.plan.profile}</SectionLabel>
              <ol style={{ margin: '0 0 8px', paddingLeft: 20, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                {selected.plan.tools.map((t, i) => <li key={i}>{describeTool(t)}</li>)}
              </ol>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, marginBottom: 10 }}>
                {selected.plan.rationale}
              </div>

              {v && (
                <>
                  <SectionLabel>Verifier checks</SectionLabel>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                    {v.checks.map((c) => (
                      <div
                        key={c.name}
                        style={{
                          display: 'flex', gap: 8, alignItems: 'flex-start',
                          padding: '5px 8px',
                          background: c.ok ? 'transparent' : 'var(--red-tint)',
                          border: `1px solid ${c.ok ? 'var(--border-subtle)' : 'var(--red-line)'}`,
                          borderRadius: 'var(--radius-sm)',
                        }}
                      >
                        <span style={{ color: c.ok ? 'var(--nominal-fg)' : 'var(--danger-fg)', flex: 'none', marginTop: 1 }}>
                          {c.ok ? <Check size={13} /> : <X size={13} />}
                        </span>
                        <div style={{ minWidth: 0 }}>
                          <span style={{
                            fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600,
                            color: c.ok ? 'var(--text-secondary)' : 'var(--danger-fg)',
                            textTransform: 'uppercase', letterSpacing: '0.05em', marginRight: 8,
                          }}>
                            {c.name}
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                            {c.reason}
                          </span>
                          {c.edit && (
                            <div style={{ fontSize: 11, color: 'var(--caution-fg)', marginTop: 3, overflowWrap: 'anywhere' }}>
                              ✎ {c.edit}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {holdUntil !== undefined && (
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      padding: '5px 8px', marginBottom: 10,
                      background: 'var(--amber-tint)',
                      border: '1px solid var(--amber-line)',
                      borderRadius: 'var(--radius-sm)',
                      color: 'var(--caution-fg)', fontSize: 11, lineHeight: 1.5,
                    }}>
                      <Clock size={13} style={{ flex: 'none' }} />
                      <span>
                        Delayed dispatch: hold until {new Date(holdUntil).toLocaleTimeString()}
                        {holdLeftS > 0
                          ? ` — ${holdLeftS} s remaining, approval is closed until then.`
                          : ' — the hold has expired; approval is open.'}
                      </span>
                    </div>
                  )}

                  {v.verdict === 'corrected' && v.correctedPlan && (
                    <>
                      <SectionLabel>Original → corrected</SectionLabel>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
                        {selected.plan.tools.map((t, i) => {
                          const c = v.correctedPlan?.tools[i];
                          const d = c ? toolDiff(t, c) : 'removed';
                          if (!d) return null;
                          return (
                            <div key={i} style={{
                              fontFamily: 'var(--font-mono)', fontSize: 11,
                              color: 'var(--caution-fg)',
                              background: 'var(--amber-tint)',
                              border: '1px solid var(--amber-line)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '4px 8px',
                            }}>
                              #{i} {t.tool}: {d}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </>
              )}

              {/* operator gate */}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                <HoldButton
                  variant="primary"
                  holdMs={900}
                  disabled={!approvable}
                  hint={
                    selected.approvedAt ? 'Accepted by the vehicle' :
                    pending ? 'Sent — awaiting the vehicle\'s ack' :
                    selected.deniedAt ? 'Denied' :
                    executing ? 'Mission in progress' :
                    !v ? 'Awaiting verification' :
                    v.verdict === 'rejected' ? 'Rejected by verifier' :
                    holdLeftS > 0 ? `Dispatch held for ${holdLeftS} s` :
                    !readinessReady ? `Readiness blocked: ${readinessReasons.join('; ')}` :
                    selected.refusedAt ? 'Refused by the vehicle — hold to send again' :
                    'Hold to approve'
                  }
                  icon={
                    !v ? <ShieldAlert size={15} /> :
                    v.verdict === 'rejected' ? <ShieldX size={15} /> :
                    <ShieldCheck size={15} />
                  }
                  onConfirm={() => onApprove(selected)}
                  style={{ flex: 1 }}
                >
                  Approve — execute {v?.verdict === 'corrected' ? 'corrected plan' : 'plan'}
                </HoldButton>
                <Button
                  variant="danger-soft"
                  disabled={!approvable}
                  onClick={() => onDeny(selected)}
                >
                  Deny
                </Button>
              </div>
              {v?.verdict === 'corrected' && (
                <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6 }}>
                  Approving sends the verifier-corrected plan ({effectivePlan(selected).requestId}).
                </div>
              )}
              {pending && (
                <div style={{ fontSize: 10, color: 'var(--caution-fg)', marginTop: 6 }}>
                  executePlan sent — nothing has launched until the vehicle acks it.
                </div>
              )}
              {selected.refusedAt !== undefined && !selected.approvedAt && (
                <div style={{
                  marginTop: 6, padding: '5px 8px',
                  background: 'var(--red-tint)', border: '1px solid var(--red-line)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--danger-fg)', fontSize: 11, lineHeight: 1.5,
                }}>
                  Vehicle REFUSED this dispatch: {selected.refusedReason || 'no reason given'}.
                  Nothing launched.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{
      fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--text-tertiary)',
      textTransform: 'uppercase', letterSpacing: '0.07em', margin: '10px 0 5px',
    }}>
      {children}
    </div>
  );
}
