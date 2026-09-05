import React from 'react';
import { FolderOpen } from 'lucide-react';
import { Panel } from '@/components/Panel';
import { Tabs } from '@/components/Tabs';
import { Badge } from '@/components/Badge';
import { IconButton } from '@/components/IconButton';
import type { StatusText } from '@/contract';

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

type FilterId = 'all' | 'warn' | 'info';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface LogConsoleProps {
  logs: StatusText[];
  recording: boolean;
  onToggleRecord: () => void;
  onOpenBrowser?: () => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

const SEV_COLOR: Record<StatusText['severity'], string> = {
  info:     'var(--text-tertiary)',
  warning:  'var(--caution-fg)',
  error:    'var(--danger-fg)',
  critical: 'var(--danger-fg)',
};

const SEV_TAG: Record<StatusText['severity'], string> = {
  info:     'INFO',
  warning:  'WARN',
  error:    'ERR ',
  critical: 'CRIT',
};

const TAB_ITEMS = [
  { id: 'all',  label: 'All' },
  { id: 'warn', label: 'Alerts' },
  { id: 'info', label: 'Info' },
];

export function LogConsole({ logs, recording, onToggleRecord, onOpenBrowser }: LogConsoleProps) {
  const [filter, setFilter] = React.useState<FilterId>('all');
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const filtered = logs.filter((l) => {
    if (filter === 'all') return true;
    if (filter === 'warn') return l.severity === 'warning' || l.severity === 'error' || l.severity === 'critical';
    return l.severity === filter;
  });

  // Auto-scroll to bottom whenever logs change or filter changes
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length, filter]);

  return (
    <Panel
      title="Event log"
      pad={false}
      status={<Badge tone="neutral" mono>{logs.length}</Badge>}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tabs
            size="sm"
            value={filter}
            onChange={(id) => setFilter(id as FilterId)}
            items={TAB_ITEMS}
          />

          {/* Record toggle */}
          <button
            onClick={onToggleRecord}
            title={recording ? 'Stop recording' : 'Start recording'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              padding: '0 10px',
              background: recording ? 'var(--red-tint)' : 'var(--surface-input)',
              border: `1px solid ${recording ? 'var(--red-line)' : 'var(--border-input)'}`,
              borderRadius: 'var(--radius-sm)',
              color: recording ? 'var(--danger-fg)' : 'var(--text-secondary)',
              fontFamily: 'var(--font-sans)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <span style={{
              width: 8,
              height: 8,
              borderRadius: recording ? 2 : '50%',
              background: recording ? 'var(--red)' : 'var(--text-tertiary)',
            }} />
            {recording ? 'REC' : 'Record'}
          </button>

          {/* Optional log browser button */}
          {onOpenBrowser && (
            <IconButton
              icon={<FolderOpen size={15} />}
              title="Open log browser"
              onClick={onOpenBrowser}
              variant="solid"
              size="sm"
            />
          )}
        </div>
      }
      style={{ height: '100%' }}
    >
      <div
        ref={scrollRef}
        style={{
          height: '100%',
          overflow: 'auto',
          padding: '6px 0',
          fontFamily: 'var(--font-mono)',
          fontSize: 11.5,
          lineHeight: 1.65,
        }}
      >
        {filtered.map((l, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 10,
              padding: '1px 12px',
              alignItems: 'baseline',
              background: l.severity === 'critical' ? 'var(--red-tint)' : 'transparent',
            }}
          >
            <span style={{
              color: 'var(--text-disabled)',
              flex: 'none',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {fmtClock(l.ts)}
            </span>
            <span style={{
              color: SEV_COLOR[l.severity],
              fontWeight: 600,
              flex: 'none',
              letterSpacing: '0.04em',
            }}>
              {SEV_TAG[l.severity]}
            </span>
            <span style={{
              color: l.severity === 'info' ? 'var(--text-secondary)' : SEV_COLOR[l.severity],
            }}>
              {l.text}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: '8px 12px', color: 'var(--text-disabled)' }}>
            No events.
          </div>
        )}
      </div>
    </Panel>
  );
}
