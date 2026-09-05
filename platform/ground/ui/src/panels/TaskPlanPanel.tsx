/* TaskPlanPanel — the "what are we being asked, and how will it be answered"
   panel. Two tabs in one slot so the rails do not spawn new panels:

     Task — the triage output the LLM (or the scripted rail) is allowed to
            emit: priority, what to look for, the question, urgency, rationale,
            source and assignment. The operator reorders the queue and types a
            note that is carried into the NEXT triage run. A task never carries
            a coordinate beyond its anomalyId, a tool, or an altitude.
     Plan — the deterministic planner's output for the selected proposal: the
            corridor it is cleared for and the ordered rule trace behind it.
            The route itself is drawn on the map, not here. */
import React from 'react';
import { ChevronDown, ChevronUp, RefreshCw, Route, Waypoints } from 'lucide-react';
import { Badge, Button, Panel, Tabs } from '@/components';
import type { MissionPlan, Task, TaskUrgency, Verification } from '@/contract';
import { TASK_QUESTION_MAX_CHARS } from '@/contract';

export interface TaskPlanPanelProps {
  tasks: Task[];
  operatorNote: string;
  onOperatorNote: (note: string) => void;
  onRunTriage: () => void;
  onReorder: (taskId: string, delta: number) => void;
  /** The data source exposes a re-runnable triage rail (offline demo only). */
  triageAvailable: boolean;
  /** The plan whose corridor + trace to show (the effective plan). */
  plan: MissionPlan | null;
  verification?: Verification | null;
  /** True when the map's drag-the-cue re-plan interaction is available. */
  dragToReplan: boolean;
}

const URGENCY_TONE: Record<TaskUrgency, 'danger' | 'caution' | 'neutral'> = {
  immediate: 'danger',
  next_sortie: 'caution',
  defer: 'neutral',
};

export function TaskPlanPanel({
  tasks,
  operatorNote,
  onOperatorNote,
  onRunTriage,
  onReorder,
  triageAvailable,
  plan,
  verification = null,
  dragToReplan,
}: TaskPlanPanelProps): React.ReactElement {
  const [tab, setTab] = React.useState<'task' | 'plan'>('task');
  const scripted = tasks.length > 0 && tasks.every((t) => t.source === 'scripted');
  const trace = plan?.planTrace ?? [];
  const corridor = plan?.corridor;

  return (
    <Panel
      title="Tasking & plan"
      pad={false}
      status={
        tab === 'task'
          ? <Badge tone={scripted ? 'caution' : 'accent'} mono>{scripted ? 'SCRIPTED TRIAGE' : tasks.length ? 'LIVE TRIAGE' : 'NO TASKS'}</Badge>
          : <Badge tone={corridor ? 'accent' : 'outline'} mono>{corridor ? 'CORRIDOR' : 'NO CORRIDOR'}</Badge>
      }
      actions={
        <Tabs
          size="sm"
          value={tab}
          onChange={(id) => setTab(id as 'task' | 'plan')}
          items={[
            { id: 'task', label: 'Task', icon: <Waypoints size={12} /> },
            { id: 'plan', label: 'Plan', icon: <Route size={12} /> },
          ]}
        />
      }
      style={{ height: '100%' }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {tab === 'task' ? (
        <>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 7 }}>
            {tasks.length === 0 ? (
              <Empty>No triage tasks yet — one is raised for each cue.</Empty>
            ) : (
              tasks.map((task, i) => (
                <TaskCard
                  key={task.taskId}
                  task={task}
                  rank={i + 1}
                  first={i === 0}
                  last={i === tasks.length - 1}
                  onReorder={onReorder}
                />
              ))
            )}
          </div>
          <div style={{ flex: 'none', borderTop: '1px solid var(--border-subtle)', padding: '8px 10px', background: 'rgba(255,255,255,0.015)' }}>
            <SectionLabel style={{ margin: '0 0 5px' }}>Operator note — sent with the next triage run</SectionLabel>
            <textarea
              value={operatorNote}
              onChange={(e) => onOperatorNote(e.target.value)}
              rows={2}
              placeholder="e.g. contractor works were scheduled on the east fence today"
              style={{
                width: '100%', resize: 'vertical', boxSizing: 'border-box',
                background: 'var(--surface-input)', color: 'var(--text-primary)',
                border: '1px solid var(--border-input)', borderRadius: 'var(--radius-sm)',
                padding: '6px 8px', fontFamily: 'var(--font-sans)', fontSize: 11,
                lineHeight: 1.45,
              }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
              <Button
                size="sm"
                variant="secondary"
                icon={<RefreshCw size={13} />}
                disabled={!triageAvailable}
                title={triageAvailable ? 'Re-run triage with this note' : 'This data source does not expose a re-runnable triage rail'}
                onClick={onRunTriage}
              >
                Re-run triage
              </Button>
              <span style={{ fontSize: 10, color: 'var(--text-disabled)', lineHeight: 1.4 }}>
                The note reaches triage only. It never becomes a route, an altitude or a setpoint.
              </span>
            </div>
          </div>
        </>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 12px 12px' }}>
          {!plan ? (
            <Empty>No plan yet — the planner proposes one once a cue is triaged.</Empty>
          ) : (
            <>
              <SectionLabel>Plan · profile {plan.profile}</SectionLabel>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-disabled)', marginBottom: 8 }}>
                {plan.requestId}
              </div>

              <SectionLabel>Corridor</SectionLabel>
              {corridor ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
                  {corridor.legs.map((leg, i) => (
                    <Row key={`leg-${i}`} label={`leg ${i + 1}`} value={`±${leg.lateral_tol_m} m lateral`} />
                  ))}
                  {corridor.orbits.map((orbit, i) => (
                    <Row key={`orbit-${i}`} label={`orbit ${i + 1}`} value={`r ${orbit.radius_m} m ±${orbit.radial_tol_m} m radial`} />
                  ))}
                  <Row label="alt band" value={`${corridor.alt_band_m.min}–${corridor.alt_band_m.max} m AGL`} />
                  <div style={{ fontSize: 10, color: 'var(--text-disabled)', lineHeight: 1.5, marginTop: 2 }}>
                    The monitor checks the vehicle against this tube, not the waypoint list —
                    a corridor breach is one comparison.
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--caution-fg)', marginBottom: 10, lineHeight: 1.5 }}>
                  This plan carries no corridor. The map draws the route only, and the envelope
                  monitor has nothing to check it against.
                </div>
              )}

              <SectionLabel>Rule trace</SectionLabel>
              {trace.length === 0 ? (
                <div style={{ fontSize: 11, color: 'var(--caution-fg)', lineHeight: 1.5 }}>
                  This plan carries no rule trace.
                </div>
              ) : (
                <ol style={{ margin: '0 0 10px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {trace.map((entry, i) => (
                    <li key={`${entry.rule}-${i}`} style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent-text)',
                        textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: 7,
                      }}>
                        {entry.rule}
                      </span>
                      <span style={{ color: 'var(--text-tertiary)' }}>{entry.effect}</span>
                    </li>
                  ))}
                </ol>
              )}

              {verification?.holdUntil && (
                <div style={{
                  fontSize: 11, color: 'var(--caution-fg)', background: 'var(--amber-tint)',
                  border: '1px solid var(--amber-line)', borderRadius: 'var(--radius-sm)',
                  padding: '5px 8px', marginBottom: 8,
                }}>
                  Dispatch held until {new Date(verification.holdUntil).toLocaleTimeString()}.
                </div>
              )}

              {dragToReplan && (
                <div style={{ fontSize: 10, color: 'var(--text-disabled)', lineHeight: 1.5, borderTop: '1px solid var(--border-subtle)', paddingTop: 7 }}>
                  Drag the cue pin on the map to re-plan from a different target. The planner
                  produces the new route and the verifier judges it — the plan is never edited by hand.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

interface TaskCardProps {
  task: Task;
  rank: number;
  first: boolean;
  last: boolean;
  onReorder: (taskId: string, delta: number) => void;
}

function TaskCard({ task, rank, first, last, onReorder }: TaskCardProps): React.ReactElement {
  const pct = Math.round(Math.max(0, Math.min(1, task.priority)) * 100);
  return (
    <div style={{
      display: 'flex', gap: 8,
      padding: '7px 8px',
      background: 'var(--surface-input)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flex: 'none' }}>
        <span style={{
          fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700,
          color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums',
        }}>
          {rank}
        </span>
        <ReorderButton label="Move up" disabled={first} onClick={() => onReorder(task.taskId, -1)}>
          <ChevronUp size={12} />
        </ReorderButton>
        <ReorderButton label="Move down" disabled={last} onClick={() => onReorder(task.taskId, 1)}>
          <ChevronDown size={12} />
        </ReorderButton>
      </div>

      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginBottom: 4 }}>
          <Badge tone={URGENCY_TONE[task.urgency]} mono>{task.urgency.replace('_', ' ')}</Badge>
          <Badge tone="accent" mono>look for {task.lookFor.replace('_', ' ')}</Badge>
          <Badge tone="outline" mono>{task.source}</Badge>
          {task.assignedTo && <Badge tone="neutral" mono>→ {task.assignedTo}</Badge>}
        </div>

        <div style={{
          fontSize: 11.5, color: 'var(--text-primary)', lineHeight: 1.45,
          overflowWrap: 'anywhere',
        }}>
          {task.question.slice(0, TASK_QUESTION_MAX_CHARS)}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.45, marginTop: 3, overflowWrap: 'anywhere' }}>
          {task.rationale}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', color: 'var(--text-tertiary)' }}>
            PRIORITY
          </span>
          <span style={{ flex: 1, height: 4, borderRadius: 999, background: 'var(--gray-5)', overflow: 'hidden' }}>
            <span style={{
              display: 'block', width: `${pct}%`, height: '100%',
              background: pct >= 80 ? 'var(--red)' : pct >= 50 ? 'var(--amber)' : 'var(--accent)',
            }} />
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            {task.priority.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}

function ReorderButton({
  children, label, disabled, onClick,
}: { children: React.ReactNode; label: string; disabled: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 15, padding: 0,
        background: 'transparent',
        border: '1px solid var(--border-subtle)',
        borderRadius: 3,
        color: disabled ? 'var(--text-disabled)' : 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
      <span style={{ color: 'var(--text-tertiary)', minWidth: 62 }}>{label}</span>
      <span style={{ color: 'var(--text-secondary)' }}>{value}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ padding: 6, color: 'var(--text-disabled)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function SectionLabel({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }): React.ReactElement {
  return (
    <div style={{
      fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--text-tertiary)',
      textTransform: 'uppercase', letterSpacing: '0.07em', margin: '10px 0 5px',
      ...style,
    }}>
      {children}
    </div>
  );
}
